// Streaming FLAC decoder for GameSong's exclusive-mode player. Written from the FLAC format
// specification (RFC 9639): STREAMINFO / SEEKTABLE, every subframe type (constant, verbatim,
// fixed, LPC), Rice residuals (incl. escape codes), wasted bits and all stereo decorrelation
// modes. Output is exact integer PCM, so the path to the DAC stays bit-perfect.
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Threading;

namespace GameSong.Exclusive
{
    /// <summary>Downloads a URL into memory on a background thread; readers block until the bytes they need arrive.</summary>
    internal sealed class HttpSource : IDisposable
    {
        readonly object gate = new object();
        byte[] data = new byte[0];
        long length = -1, have;
        bool done;
        string error;
        volatile bool cancelled;
        HttpWebRequest request;

        public HttpSource(string url)
        {
            var t = new Thread(() => Run(url)) { IsBackground = true, Name = "download" };
            t.Start();
        }

        void Run(string url)
        {
            try
            {
                request = (HttpWebRequest)WebRequest.Create(url);
                request.UserAgent = "GameSong (Windows; exclusive mode)";
                request.Timeout = 20000;
                request.ReadWriteTimeout = 30000;
                using (var resp = (HttpWebResponse)request.GetResponse())
                using (var s = resp.GetResponseStream())
                {
                    long len = resp.ContentLength;
                    lock (gate) { length = len; data = new byte[len > 0 ? len : 8 << 20]; Monitor.PulseAll(gate); }
                    var buf = new byte[65536];
                    int n;
                    while (!cancelled && (n = s.Read(buf, 0, buf.Length)) > 0)
                    {
                        lock (gate)
                        {
                            if (have + n > data.Length) Array.Resize(ref data, (int)Math.Max(data.Length * 2L, have + n));
                            Buffer.BlockCopy(buf, 0, data, (int)have, n);
                            have += n;
                            Monitor.PulseAll(gate);
                        }
                    }
                }
            }
            catch (Exception e) { if (!cancelled) lock (gate) error = e.Message; }
            finally { lock (gate) { done = true; if (length < 0) length = have; Monitor.PulseAll(gate); } }
        }

        /// <summary>Copies bytes at <paramref name="pos"/>, waiting for the download if needed. Returns 0 at the end.</summary>
        public int ReadAt(long pos, byte[] dst, int off, int count)
        {
            lock (gate)
            {
                while (!cancelled && have <= pos && !done) Monitor.Wait(gate, 500);
                if (cancelled) throw new OperationCanceledException();
                if (have <= pos)
                {
                    if (error != null) throw new IOException("Download failed: " + error);
                    return 0;
                }
                int n = (int)Math.Min(count, have - pos);
                Buffer.BlockCopy(data, (int)pos, dst, off, n);
                return n;
            }
        }

        public long Length
        {
            get { lock (gate) { while (!cancelled && length < 0 && !done) Monitor.Wait(gate, 500); return length; } }
        }

        public long Downloaded { get { lock (gate) return have; } }

        public void Dispose()
        {
            cancelled = true;
            try { if (request != null) request.Abort(); } catch { }
            lock (gate) Monitor.PulseAll(gate);
        }
    }

    /// <summary>MSB-first bit reader over an HttpSource.</summary>
    internal sealed class BitReader
    {
        readonly HttpSource src;
        readonly byte[] buf = new byte[65536];
        long bufStart;
        int bufLen, bufPos;
        ulong cache;
        int bits;

        public BitReader(HttpSource src, long pos) { this.src = src; Seek(pos); }

        public void Seek(long pos) { bufStart = pos; bufLen = 0; bufPos = 0; cache = 0; bits = 0; }

        /// <summary>Byte offset of the next unread byte (exact when byte-aligned).</summary>
        public long BytePos { get { return bufStart + bufPos - bits / 8; } }

        int NextByte()
        {
            if (bufPos >= bufLen)
            {
                bufStart += bufLen;
                bufPos = 0;
                bufLen = src.ReadAt(bufStart, buf, 0, buf.Length);
                if (bufLen <= 0) { bufLen = 0; throw new EndOfStreamException(); }
            }
            return buf[bufPos++];
        }

        public uint Read(int n)
        {
            if (n == 0) return 0;
            while (bits < n) { cache = (cache << 8) | (uint)NextByte(); bits += 8; }
            bits -= n;
            return (uint)((cache >> bits) & ((1UL << n) - 1));
        }

        public long ReadSigned(int n)
        {
            if (n == 0) return 0;
            if (n <= 32) { ulong v = Read(n); return (long)(v << (64 - n)) >> (64 - n); }
            ulong hi = Read(n - 32), lo = Read(32);
            ulong w = (hi << 32) | lo;
            return (long)(w << (64 - n)) >> (64 - n);
        }

        public uint ReadUnary()
        {
            uint count = 0;
            while (true)
            {
                if (bits == 0) { cache = (cache << 8) | (uint)NextByte(); bits = 8; }
                ulong v = cache & ((1UL << bits) - 1);
                if (v == 0) { count += (uint)bits; bits = 0; continue; }
                int z = 0;
                while (((v >> (bits - 1 - z)) & 1) == 0) z++;
                count += (uint)z;
                bits -= z + 1;
                return count;
            }
        }

        public void Align() { bits -= bits % 8; }
    }

    internal sealed class FlacException : Exception { public FlacException(string m) : base(m) { } }

    internal sealed class FlacDecoder
    {
        /// <summary>FLAC blocks hold at most 65535 samples per channel: size DecodeFrame buffers with this.</summary>
        public const int MaxFrameSamples = 65536;
        public int SampleRate, Channels, BitsPerSample, MinBlock, MaxBlock;
        public long TotalSamples;
        long firstFrame;
        readonly List<long[]> seekTable = new List<long[]>(); // {sample, byteOffset}
        readonly HttpSource src;
        readonly BitReader br;
        long[][] ch;
        long pendingSkip;

        static readonly byte[] Crc8Table = BuildCrc8();

        public double Duration { get { return SampleRate > 0 ? (double)TotalSamples / SampleRate : 0; } }

        public FlacDecoder(HttpSource src)
        {
            this.src = src;
            br = new BitReader(src, 0);
            ReadHeader();
            ch = new long[Channels][];
            for (int i = 0; i < Channels; i++) ch[i] = new long[Math.Max(MaxBlock, 16)];
        }

        void ReadHeader()
        {
            uint magic = br.Read(32);
            if ((magic >> 8) == 0x494433) // "ID3": skip an ID3v2 tag
            {
                br.Read(16); // minor version + flags (we consumed "ID3" + major version)
                int size = 0;
                for (int i = 0; i < 4; i++) size = (size << 7) | (int)(br.Read(8) & 0x7F);
                for (int i = 0; i < size; i++) br.Read(8);
                magic = br.Read(32);
            }
            if (magic != 0x664C6143) throw new FlacException("not a FLAC file");
            bool last = false;
            while (!last)
            {
                last = br.Read(1) == 1;
                int type = (int)br.Read(7);
                int len = (int)br.Read(24);
                if (type == 0)
                {
                    MinBlock = (int)br.Read(16);
                    MaxBlock = (int)br.Read(16);
                    br.Read(24); br.Read(24);
                    SampleRate = (int)br.Read(20);
                    Channels = (int)br.Read(3) + 1;
                    BitsPerSample = (int)br.Read(5) + 1;
                    TotalSamples = ((long)br.Read(4) << 32) | br.Read(32);
                    for (int i = 0; i < 16; i++) br.Read(8); // MD5
                }
                else if (type == 3)
                {
                    for (int i = 0; i < len / 18; i++)
                    {
                        ulong sample = ((ulong)br.Read(32) << 32) | br.Read(32);
                        ulong off = ((ulong)br.Read(32) << 32) | br.Read(32);
                        br.Read(16);
                        if (sample != ulong.MaxValue) seekTable.Add(new long[] { (long)sample, (long)off });
                    }
                    for (int i = 0; i < len % 18; i++) br.Read(8);
                }
                else for (int i = 0; i < len; i++) br.Read(8);
            }
            if (SampleRate <= 0 || BitsPerSample < 4 || BitsPerSample > 32) throw new FlacException("unsupported STREAMINFO");
            firstFrame = br.BytePos;
        }

        static byte[] BuildCrc8()
        {
            var t = new byte[256];
            for (int i = 0; i < 256; i++)
            {
                int c = i;
                for (int k = 0; k < 8; k++) c = (c & 0x80) != 0 ? ((c << 1) ^ 0x07) : (c << 1);
                t[i] = (byte)c;
            }
            return t;
        }

        static readonly int[] SizeBits = { 0, 8, 12, 0, 16, 20, 24, 32 };

        struct Header { public int BlockSize, Bps, ChanCode; public long FirstSample; }

        /// <summary>Parses a frame header at the reader's (aligned) position. Returns false if it isn't one (bad sync / CRC).</summary>
        bool TryHeader(BitReader r, out Header h)
        {
            h = new Header();
            byte crc = 0;
            Func<int, uint> rd = nBytes =>
            {
                uint v = 0;
                for (int i = 0; i < nBytes; i++) { uint b = r.Read(8); crc = Crc8Table[crc ^ b]; v = (v << 8) | b; }
                return v;
            };
            uint sync = rd(2);
            if ((sync & 0xFFFE) != 0xFFF8) return false;
            bool variable = (sync & 1) == 1;
            uint b2 = rd(1), b3 = rd(1);
            int bsCode = (int)(b2 >> 4), srCode = (int)(b2 & 15);
            h.ChanCode = (int)(b3 >> 4);
            int ssCode = (int)((b3 >> 1) & 7);
            if (bsCode == 0 || srCode == 15 || h.ChanCode > 10 || ssCode == 3) return false;
            // UTF-8 style coded frame / sample number
            uint first = rd(1);
            int extra = 0;
            ulong num;
            if ((first & 0x80) == 0) num = first;
            else
            {
                int mask = 0x40;
                while ((first & mask) != 0 && extra < 6) { extra++; mask >>= 1; }
                if (extra == 0) return false;
                num = first & (uint)(mask - 1);
                for (int i = 0; i < extra; i++)
                {
                    uint c = rd(1);
                    if ((c & 0xC0) != 0x80) return false;
                    num = (num << 6) | (c & 0x3F);
                }
            }
            if (bsCode == 1) h.BlockSize = 192;
            else if (bsCode <= 5) h.BlockSize = 576 << (bsCode - 2);
            else if (bsCode == 6) h.BlockSize = (int)rd(1) + 1;
            else if (bsCode == 7) h.BlockSize = (int)rd(2) + 1;
            else h.BlockSize = 256 << (bsCode - 8);
            if (srCode == 12) rd(1); else if (srCode == 13 || srCode == 14) rd(2);
            uint expected = r.Read(8);
            if (expected != crc) return false;
            h.Bps = ssCode == 0 ? BitsPerSample : SizeBits[ssCode];
            int fixedBlock = MinBlock == MaxBlock ? MaxBlock : h.BlockSize;
            h.FirstSample = variable ? (long)num : (long)num * fixedBlock;
            int nch = h.ChanCode < 8 ? h.ChanCode + 1 : 2;
            if (nch != Channels || h.BlockSize > Math.Max(MaxBlock, 16) * 2) return false;
            return true;
        }

        /// <summary>Decodes the next frame into <paramref name="dst"/> (interleaved, MSB-aligned 32-bit). Returns frames written; 0 at end of stream.</summary>
        public int DecodeFrame(int[] dst)
        {
            while (true)
            {
                br.Align();
                long start = br.BytePos;
                Header h;
                bool ok;
                try { ok = TryHeader(br, out h); }
                catch (EndOfStreamException) { return 0; }
                if (!ok)
                {
                    // Lost sync (shouldn't happen on a clean stream): resume searching one byte further.
                    br.Seek(start + 1);
                    long next = FindFrame(start + 1);
                    if (next < 0) return 0;
                    br.Seek(next);
                    continue;
                }
                int n = h.BlockSize;
                if (ch[0].Length < n) for (int i = 0; i < Channels; i++) ch[i] = new long[n];
                try
                {
                    for (int c = 0; c < Channels; c++)
                    {
                        int bps = h.Bps;
                        if ((h.ChanCode == 8 && c == 1) || (h.ChanCode == 9 && c == 0) || (h.ChanCode == 10 && c == 1)) bps++;
                        Subframe(ch[c], n, bps);
                    }
                    br.Align();
                    br.Read(16); // CRC-16 of the frame
                }
                catch (EndOfStreamException) { return 0; }
                Decorrelate(h.ChanCode, n);

                int skip = 0;
                if (pendingSkip > 0) { skip = (int)Math.Min(pendingSkip, n); pendingSkip -= skip; }
                int shift = 32 - BitsPerSample;
                int k = 0;
                for (int i = skip; i < n; i++)
                    for (int c = 0; c < Channels; c++) dst[k++] = (int)(ch[c][i] << shift);
                if (n - skip > 0) return n - skip;
            }
        }

        void Decorrelate(int code, int n)
        {
            long[] a = Channels > 0 ? ch[0] : null, b = Channels > 1 ? ch[1] : null;
            switch (code)
            {
                case 8: for (int i = 0; i < n; i++) b[i] = a[i] - b[i]; break;           // left/side
                case 9: for (int i = 0; i < n; i++) a[i] = a[i] + b[i]; break;           // side/right
                case 10:                                                                 // mid/side
                    for (int i = 0; i < n; i++)
                    {
                        long side = b[i];
                        long mid = (a[i] << 1) | (side & 1);
                        a[i] = (mid + side) >> 1;
                        b[i] = (mid - side) >> 1;
                    }
                    break;
            }
        }

        void Subframe(long[] s, int n, int bps)
        {
            br.Read(1);
            int type = (int)br.Read(6);
            int wasted = 0;
            if (br.Read(1) == 1) wasted = (int)br.ReadUnary() + 1;
            bps -= wasted;
            if (type == 0)
            {
                long v = br.ReadSigned(bps);
                for (int i = 0; i < n; i++) s[i] = v;
            }
            else if (type == 1)
            {
                for (int i = 0; i < n; i++) s[i] = br.ReadSigned(bps);
            }
            else if (type >= 8 && type <= 12)
            {
                int order = type & 7;
                for (int i = 0; i < order; i++) s[i] = br.ReadSigned(bps);
                Residual(s, n, order);
                switch (order)
                {
                    case 1: for (int i = 1; i < n; i++) s[i] += s[i - 1]; break;
                    case 2: for (int i = 2; i < n; i++) s[i] += 2 * s[i - 1] - s[i - 2]; break;
                    case 3: for (int i = 3; i < n; i++) s[i] += 3 * s[i - 1] - 3 * s[i - 2] + s[i - 3]; break;
                    case 4: for (int i = 4; i < n; i++) s[i] += 4 * s[i - 1] - 6 * s[i - 2] + 4 * s[i - 3] - s[i - 4]; break;
                }
            }
            else if (type >= 32)
            {
                int order = (type & 31) + 1;
                for (int i = 0; i < order; i++) s[i] = br.ReadSigned(bps);
                int precision = (int)br.Read(4) + 1;
                if (precision == 16) throw new FlacException("invalid LPC precision");
                int qShift = (int)br.ReadSigned(5);
                if (qShift < 0) qShift = 0;
                var coef = new long[order];
                for (int i = 0; i < order; i++) coef[i] = br.ReadSigned(precision);
                Residual(s, n, order);
                for (int i = order; i < n; i++)
                {
                    long sum = 0;
                    for (int j = 0; j < order; j++) sum += coef[j] * s[i - 1 - j];
                    s[i] += sum >> qShift;
                }
            }
            else throw new FlacException("reserved subframe type " + type);
            if (wasted > 0) for (int i = 0; i < n; i++) s[i] <<= wasted;
        }

        void Residual(long[] s, int n, int order)
        {
            int method = (int)br.Read(2);
            if (method > 1) throw new FlacException("reserved residual coding method");
            int paramBits = method == 0 ? 4 : 5;
            uint escape = method == 0 ? 15u : 31u;
            int partOrder = (int)br.Read(4);
            int parts = 1 << partOrder;
            int idx = order;
            for (int p = 0; p < parts; p++)
            {
                int count = (n >> partOrder) - (p == 0 ? order : 0);
                uint param = br.Read(paramBits);
                if (param == escape)
                {
                    int raw = (int)br.Read(5);
                    for (int i = 0; i < count; i++) s[idx++] = raw == 0 ? 0 : br.ReadSigned(raw);
                }
                else
                {
                    int k = (int)param;
                    for (int i = 0; i < count; i++)
                    {
                        ulong q = br.ReadUnary();
                        ulong v = (q << k) | (k > 0 ? br.Read(k) : 0u);
                        s[idx++] = (long)(v >> 1) ^ -(long)(v & 1);
                    }
                }
            }
        }

        /// <summary>Finds the first valid frame header at or after <paramref name="from"/>. Returns its byte offset or -1.</summary>
        long FindFrame(long from)
        {
            var win = new byte[65536];
            long pos = from;
            while (true)
            {
                int got = src.ReadAt(pos, win, 0, win.Length);
                if (got < 2) return -1;
                for (int i = 0; i < got - 1; i++)
                {
                    if (win[i] != 0xFF || (win[i + 1] & 0xFE) != 0xF8) continue;
                    var r = new BitReader(src, pos + i);
                    Header h;
                    try { if (TryHeader(r, out h)) return pos + i; } catch (EndOfStreamException) { return -1; }
                }
                pos += got - 1;
            }
        }

        long FirstSampleAt(long offset)
        {
            var r = new BitReader(src, offset);
            Header h;
            return TryHeader(r, out h) ? h.FirstSample : -1;
        }

        /// <summary>Positions the decoder so the next decoded sample is <paramref name="target"/>.</summary>
        public void SeekTo(long target)
        {
            pendingSkip = 0;
            if (target <= 0) { br.Seek(firstFrame); return; }
            if (TotalSamples > 0 && target >= TotalSamples) target = TotalSamples - 1;

            long off = firstFrame;
            long[] best = null;
            foreach (var p in seekTable) if (p[0] <= target && (best == null || p[0] > best[0])) best = p;
            if (best != null) off = firstFrame + best[1];
            else if (TotalSamples > 0)
            {
                long len = src.Length;
                long est = firstFrame + (long)((len - firstFrame) * ((double)target / TotalSamples)) - 65536;
                off = Math.Max(firstFrame, est);
            }

            for (int guard = 0; guard < 64; guard++)
            {
                long frame = FindFrame(off);
                long first = frame >= 0 ? FirstSampleAt(frame) : -1;
                if (frame < 0 || first < 0 || first > target)
                {
                    if (off <= firstFrame) { frame = firstFrame; first = 0; }
                    else { off = Math.Max(firstFrame, off - 262144); continue; }
                }
                br.Seek(frame);
                pendingSkip = target - first;
                return;
            }
            br.Seek(firstFrame);
            pendingSkip = target;
        }
    }
}
