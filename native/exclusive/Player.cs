// WASAPI exclusive-mode player: opens the default playback device at the FLAC's own format
// (the integer samples are only zero-padded into the device's container, never resampled,
// dithered or volume-scaled), and plays a streamed FLAC through it.
// The event-driven render loop, buffer-alignment handling and "feed silence while paused"
// approach follow SoDaPlayer's PlaybackEngine.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace GameSong.Exclusive
{
    internal sealed class PcmFormat
    {
        public int SampleRate, Channels, ContainerBits, ValidBits;
        static readonly Guid SubtypePcm = new Guid("00000001-0000-0010-8000-00AA00389B71");

        public int BytesPerSample { get { return ContainerBits / 8; } }
        public int BlockAlign { get { return Channels * BytesPerSample; } }

        static int ChannelMask(int channels)
        {
            switch (channels) { case 1: return 0x4; case 2: return 0x3; case 4: return 0x33; case 6: return 0x3F; case 8: return 0x63F; default: return 0; }
        }

        public IntPtr AllocWaveFormat()
        {
            IntPtr p = Marshal.AllocHGlobal(40);
            int bps = ContainerBits / 8;
            Marshal.WriteInt16(p, 0, unchecked((short)0xFFFE));
            Marshal.WriteInt16(p, 2, (short)Channels);
            Marshal.WriteInt32(p, 4, SampleRate);
            Marshal.WriteInt32(p, 8, SampleRate * Channels * bps);
            Marshal.WriteInt16(p, 12, (short)(Channels * bps));
            Marshal.WriteInt16(p, 14, (short)ContainerBits);
            Marshal.WriteInt16(p, 16, 22);
            Marshal.WriteInt16(p, 18, (short)ValidBits);
            Marshal.WriteInt32(p, 20, ChannelMask(Channels));
            Marshal.Copy(SubtypePcm.ToByteArray(), 0, p + 24, 16);
            return p;
        }

        public bool SameAs(PcmFormat o)
        {
            return o != null && o.SampleRate == SampleRate && o.Channels == Channels && o.ContainerBits == ContainerBits && o.ValidBits == ValidBits;
        }

        public string Describe()
        {
            string bits = ValidBits == ContainerBits ? ValidBits + "-bit" : ValidBits + "-bit in " + ContainerBits;
            return bits + " / " + (SampleRate / 1000.0).ToString("0.###", System.Globalization.CultureInfo.InvariantCulture) + " kHz / " +
                   (Channels == 1 ? "mono" : Channels == 2 ? "stereo" : Channels + " ch");
        }

        /// <summary>
        /// Bit-perfect candidates only: the file's own rate, an integer container with at least the file's
        /// bit depth (smaller samples are zero-padded, which is lossless). Mono may be duplicated to stereo.
        /// </summary>
        public static List<PcmFormat> Candidates(int rate, int channels, int bits)
        {
            var containers = new List<int[]>();
            if (bits <= 16) containers.Add(new[] { 16, 16 });
            if (bits <= 24) { containers.Add(new[] { 24, 24 }); containers.Add(new[] { 32, 24 }); }
            containers.Add(new[] { 32, 32 });
            var list = new List<PcmFormat>();
            var chans = new List<int> { channels };
            if (channels == 1) chans.Add(2);
            foreach (int c in chans)
                foreach (var k in containers)
                    list.Add(new PcmFormat { SampleRate = rate, Channels = c, ContainerBits = k[0], ValidBits = k[1] });
            return list;
        }
    }

    /// <summary>An open exclusive-mode stream on the default device.</summary>
    internal sealed class Session : IDisposable
    {
        public IMMDevice Device;
        public IAudioClient Client;
        public IAudioRenderClient Render;
        public AutoResetEvent Event;
        public PcmFormat Format;
        public uint BufferFrames;
        public string DeviceName;
        public EndpointVolume Volume;

        const long PeriodHns = 400000; // 40 ms: comfortably above GC / scheduling jitter

        public static Session Open(List<PcmFormat> candidates)
        {
            IMMDevice dev = Wasapi.DefaultDevice();
            IAudioClient client = null;
            bool ok = false;
            try
            {
                client = Wasapi.ActivateAudioClient(dev);
                long defPeriod, minPeriod;
                Wasapi.Check(client.GetDevicePeriod(out defPeriod, out minPeriod), "GetDevicePeriod");
                long period = Math.Max(minPeriod, PeriodHns);
                int lastHr = Wasapi.E_UNSUPPORTED_FORMAT;
                foreach (PcmFormat f in candidates)
                {
                    IntPtr wfx = f.AllocWaveFormat();
                    try
                    {
                        int hr = client.IsFormatSupported(ShareMode.Exclusive, wfx, IntPtr.Zero);
                        if (hr == Wasapi.E_DEVICE_IN_USE || hr == Wasapi.E_EXCLUSIVE_MODE_NOT_ALLOWED) throw new AudioException(Wasapi.Describe(hr), hr);
                        if (hr != Wasapi.S_OK) { lastHr = hr; continue; }
                        long p = period;
                        hr = client.Initialize(ShareMode.Exclusive, Wasapi.STREAMFLAGS_EVENTCALLBACK, p, p, wfx, IntPtr.Zero);
                        if (hr == Wasapi.E_BUFFER_SIZE_NOT_ALIGNED)
                        {
                            // Documented dance: ask for the aligned size, then re-create the client with that period.
                            uint aligned;
                            client.GetBufferSize(out aligned);
                            p = (long)(10000.0 * 1000 * aligned / f.SampleRate + 0.5);
                            Wasapi.Release(client);
                            client = Wasapi.ActivateAudioClient(dev);
                            hr = client.Initialize(ShareMode.Exclusive, Wasapi.STREAMFLAGS_EVENTCALLBACK, p, p, wfx, IntPtr.Zero);
                        }
                        if ((hr == Wasapi.E_INVALID_DEVICE_PERIOD || hr == Wasapi.E_BUFFER_SIZE_ERROR) && p != defPeriod)
                        {
                            Wasapi.Release(client);
                            client = Wasapi.ActivateAudioClient(dev);
                            p = defPeriod;
                            hr = client.Initialize(ShareMode.Exclusive, Wasapi.STREAMFLAGS_EVENTCALLBACK, p, p, wfx, IntPtr.Zero);
                        }
                        if (hr == Wasapi.S_OK)
                        {
                            var s = new Session { Device = dev, Client = client, Format = f, Event = new AutoResetEvent(false) };
                            Wasapi.Check(client.SetEventHandle(s.Event.SafeWaitHandle.DangerousGetHandle()), "SetEventHandle");
                            Wasapi.Check(client.GetBufferSize(out s.BufferFrames), "GetBufferSize");
                            Guid iid = Wasapi.IID_IAudioRenderClient;
                            object o;
                            Wasapi.Check(client.GetService(ref iid, out o), "GetService(IAudioRenderClient)");
                            s.Render = (IAudioRenderClient)o;
                            s.DeviceName = Wasapi.FriendlyName(dev);
                            try { s.Volume = new EndpointVolume(dev); } catch { s.Volume = null; }
                            ok = true;
                            return s;
                        }
                        lastHr = hr;
                        if (hr == Wasapi.E_DEVICE_IN_USE || hr == Wasapi.E_EXCLUSIVE_MODE_NOT_ALLOWED) throw new AudioException(Wasapi.Describe(hr), hr);
                        Wasapi.Release(client);
                        client = Wasapi.ActivateAudioClient(dev);
                    }
                    finally { Marshal.FreeHGlobal(wfx); }
                }
                throw new AudioException(Wasapi.Describe(lastHr), lastHr);
            }
            finally
            {
                if (!ok) { Wasapi.Release(client); Wasapi.Release(dev); }
            }
        }

        public void Dispose()
        {
            try { if (Client != null) Client.Stop(); } catch { }
            if (Volume != null) Volume.Dispose();
            Wasapi.Release(Render); Wasapi.Release(Client); Wasapi.Release(Device);
            Render = null; Client = null; Device = null;
            if (Event != null) Event.Dispose();
        }
    }

    /// <summary>Interleaved MSB-aligned 32-bit samples between the decode thread and the audio thread.</summary>
    internal sealed class Ring
    {
        readonly int[] buf;
        readonly int channels;
        int head, count; // in samples
        readonly object gate = new object();
        public volatile bool Cancelled;

        public Ring(int frames, int channels) { this.channels = channels; buf = new int[frames * channels]; }

        public int FramesAvailable { get { lock (gate) return count / channels; } }

        public void Write(int[] src, int frames)
        {
            int samples = frames * channels, off = 0;
            lock (gate)
            {
                while (samples > 0)
                {
                    while (!Cancelled && count == buf.Length) Monitor.Wait(gate, 200);
                    if (Cancelled) return;
                    int tail = (head + count) % buf.Length;
                    int n = Math.Min(samples, Math.Min(buf.Length - count, buf.Length - tail));
                    Array.Copy(src, off, buf, tail, n);
                    count += n; off += n; samples -= n;
                }
            }
        }

        public int Read(int[] dst, int maxFrames)
        {
            lock (gate)
            {
                int samples = Math.Min(maxFrames * channels, count);
                samples -= samples % channels;
                int off = 0;
                while (off < samples)
                {
                    int n = Math.Min(samples - off, buf.Length - head);
                    Array.Copy(buf, head, dst, off, n);
                    head = (head + n) % buf.Length;
                    count -= n; off += n;
                }
                Monitor.PulseAll(gate);
                return samples / channels;
            }
        }

        public void Cancel() { lock (gate) { Cancelled = true; Monitor.PulseAll(gate); } }
    }

    /// <summary>One streamed track: download + decoder + decode thread feeding a ring.</summary>
    internal sealed class Track
    {
        public HttpSource Source;
        public FlacDecoder Decoder;
        public Ring Ring;
        public long StartFrame;        // where the current decode run began
        public long Played;            // frames handed to the device since StartFrame
        public volatile bool Drained;
        public bool EndedSent;
        public int DrainPeriods;
        Thread thread;

        public void StartDecoding(long frame)
        {
            StartFrame = frame;
            Played = 0;
            Drained = false;
            EndedSent = false;
            DrainPeriods = 0;
            Decoder.SeekTo(frame);
            Ring = new Ring(Decoder.SampleRate * 4, Decoder.Channels);
            Ring ring = Ring;
            thread = new Thread(() => DecodeLoop(ring)) { IsBackground = true, Name = "decode" };
            thread.Start();
        }

        void DecodeLoop(Ring ring)
        {
            var frame = new int[FlacDecoder.MaxFrameSamples * Decoder.Channels];
            try
            {
                while (!ring.Cancelled)
                {
                    int n = Decoder.DecodeFrame(frame);
                    if (n <= 0) break;
                    ring.Write(frame, n);
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception e) { if (!ring.Cancelled) Program.Send("error", "code", "decode", "message", "Couldn't decode the FLAC stream: " + e.Message); }
            if (!ring.Cancelled) Drained = true;
        }

        public void StopDecoding()
        {
            if (Ring != null) Ring.Cancel();
            if (thread != null) thread.Join(2000);
            thread = null;
        }

        public void Dispose()
        {
            if (Source != null) Source.Dispose(); // unblocks a decoder waiting for bytes
            StopDecoding();
        }
    }

    internal sealed class Player
    {
        // `gate` serialises commands. The audio thread never takes it (it reads the volatile fields
        // below), so stopping / joining that thread while holding it can't deadlock.
        readonly object gate = new object();
        volatile Session session;
        volatile Track track;
        Thread audioThread;
        volatile bool audioRun;
        volatile bool paused = true;
        volatile bool seeking;
        int generation;

        // ------------------------------------------------------------------ commands

        public void Load(string url, double start, bool autoplay, object id)
        {
            int gen = Interlocked.Increment(ref generation);
            lock (gate) { if (track != null) { track.Dispose(); track = null; } }
            Track t = null;
            try
            {
                t = new Track { Source = new HttpSource(url) };
                t.Decoder = new FlacDecoder(t.Source);
                if (gen != generation) { t.Dispose(); return; }
                var dec = t.Decoder;
                var candidates = PcmFormat.Candidates(dec.SampleRate, dec.Channels, dec.BitsPerSample);

                lock (gate)
                {
                    // Keep the open stream when the format matches (no relock / click between tracks).
                    Session cur = session;
                    bool reuse = cur != null && candidates.Exists(c => c.SameAs(cur.Format));
                    if (!reuse)
                    {
                        StopAudio();
                        session = Session.Open(candidates);
                    }
                    paused = !autoplay;
                    t.StartDecoding((long)Math.Round(Math.Max(0, start) * dec.SampleRate));
                    track = t;
                    if (!reuse) StartAudio();
                }
                var vol = session.Volume;
                Program.Send("ready",
                    "id", id,
                    "duration", dec.Duration,
                    "source", dec.BitsPerSample + "-bit / " + (dec.SampleRate / 1000.0).ToString("0.###", System.Globalization.CultureInfo.InvariantCulture) + " kHz FLAC",
                    "format", session.Format.Describe(),
                    "device", session.DeviceName,
                    "volume", vol != null ? (object)vol.Level : null,
                    "hardwareVolume", vol != null && vol.Hardware);
                Program.Send("state", "state", paused ? "paused" : "playing");
            }
            catch (AudioException e)
            {
                if (t != null) t.Dispose();
                Program.Send("error", "id", id, "code", Wasapi.Code(e.HResult2), "message", e.Message);
            }
            catch (Exception e)
            {
                if (t != null) t.Dispose();
                if (gen == generation) Program.Send("error", "id", id, "code", e is FlacException ? "decode" : "network", "message", e.Message);
            }
        }

        public void Play() { paused = false; Program.Send("state", "state", "playing"); }
        public void Pause() { paused = true; Program.Send("state", "state", "paused"); }

        public void Seek(double seconds)
        {
            lock (gate)
            {
                Track t = track;
                if (t == null) return;
                seeking = true; // the audio thread plays silence until the new position is decoded
                try
                {
                    t.StopDecoding();
                    t.StartDecoding((long)Math.Round(Math.Max(0, seconds) * t.Decoder.SampleRate));
                }
                finally { seeking = false; }
            }
            Program.Send("seeked", "position", seconds);
        }

        /// <summary>Stops playback and releases the device so other apps can use it again.</summary>
        public void Stop()
        {
            Interlocked.Increment(ref generation);
            lock (gate)
            {
                if (track != null) { track.Dispose(); track = null; }
                StopAudio();
            }
            Program.Send("state", "state", "stopped");
        }

        // ------------------------------------------------------------------ audio thread

        void StartAudio()
        {
            audioRun = true;
            Session s = session;
            audioThread = new Thread(() => AudioLoop(s)) { IsBackground = true, Name = "wasapi", Priority = ThreadPriority.Highest };
            audioThread.Start();
        }

        void StopAudio()
        {
            audioRun = false;
            if (audioThread != null && audioThread != Thread.CurrentThread) audioThread.Join(3000);
            audioThread = null;
            Session s = session;
            session = null;
            if (s != null) s.Dispose();
        }

        void AudioLoop(Session s)
        {
            uint taskIndex = 0;
            IntPtr mmcss = IntPtr.Zero;
            try { mmcss = NativeMethods.AvSetMmThreadCharacteristics("Pro Audio", ref taskIndex); } catch { }
            var fmt = s.Format;
            int frames = (int)s.BufferFrames;
            int srcChannels = 0;
            var pcm = new int[frames * 8];
            var bytes = new byte[frames * fmt.BlockAlign];
            long lastReport = 0;
            try
            {
                Fill(s, frames, pcm, bytes, ref srcChannels);   // pre-fill before Start (event-driven mode)
                Wasapi.Check(s.Client.Start(), "IAudioClient.Start");
                while (audioRun)
                {
                    if (!s.Event.WaitOne(2000)) throw new AudioException("the audio device stopped requesting data", Wasapi.E_DEVICE_INVALIDATED);
                    if (!audioRun) break;
                    Fill(s, frames, pcm, bytes, ref srcChannels);
                    long now = Environment.TickCount;
                    if (now - lastReport >= 250) { lastReport = now; ReportPosition(); }
                }
            }
            catch (Exception e)
            {
                if (audioRun)
                {
                    var ae = e as AudioException;
                    Program.Send("error", "code", ae != null ? Wasapi.Code(ae.HResult2) : "device", "message", e.Message);
                }
            }
            finally
            {
                if (mmcss != IntPtr.Zero) NativeMethods.AvRevertMmThreadCharacteristics(mmcss);
            }
        }

        /// <summary>Writes one device period: decoded audio when playing, digital silence otherwise.</summary>
        void Fill(Session s, int frames, int[] pcm, byte[] bytes, ref int srcChannels)
        {
            var fmt = s.Format;
            int got = 0;
            Track t = track;
            Ring ring = t != null ? t.Ring : null;
            if (t != null && ring != null && !paused && !seeking)
            {
                int ch = t.Decoder.Channels;   // pcm is sized for up to 8 channels
                got = ring.Read(pcm, frames);
                srcChannels = ch;
                Convert(pcm, got, ch, bytes, fmt);
                t.Played += got;
            }
            if (got < frames) Array.Clear(bytes, got * fmt.BlockAlign, (frames - got) * fmt.BlockAlign);

            IntPtr p;
            Wasapi.Check(s.Render.GetBuffer((uint)frames, out p), "IAudioRenderClient.GetBuffer");
            Marshal.Copy(bytes, 0, p, frames * fmt.BlockAlign);
            Wasapi.Check(s.Render.ReleaseBuffer((uint)frames, 0), "IAudioRenderClient.ReleaseBuffer");

            // End of track: everything decoded and played out (two silent periods for the device to drain).
            if (t != null && ring != null && !paused && !seeking && got == 0 && t.Drained && !t.EndedSent && ring.FramesAvailable == 0)
            {
                if (++t.DrainPeriods >= 2) { t.EndedSent = true; Program.Send("ended"); }
            }
        }

        /// <summary>Integer-only conversion: MSB-aligned samples are written into the container's top bytes (zero padding = lossless).</summary>
        static void Convert(int[] src, int frames, int inCh, byte[] dst, PcmFormat fmt)
        {
            int outCh = fmt.Channels, bps = fmt.BytesPerSample, d = 0;
            bool dup = inCh == 1 && outCh == 2;
            for (int f = 0; f < frames; f++)
            {
                for (int c = 0; c < outCh; c++)
                {
                    int v = src[f * inCh + (dup ? 0 : c)];
                    if (bps == 4) { dst[d] = (byte)v; dst[d + 1] = (byte)(v >> 8); dst[d + 2] = (byte)(v >> 16); dst[d + 3] = (byte)(v >> 24); }
                    else if (bps == 3) { dst[d] = (byte)(v >> 8); dst[d + 1] = (byte)(v >> 16); dst[d + 2] = (byte)(v >> 24); }
                    else { dst[d] = (byte)(v >> 16); dst[d + 1] = (byte)(v >> 24); }
                    d += bps;
                }
            }
        }

        void ReportPosition()
        {
            Track t = track;
            if (t == null || t.Decoder == null || seeking) return;
            var dec = t.Decoder;
            double pos = (double)(t.StartFrame + t.Played) / dec.SampleRate;
            long len = t.Source.Length;
            double buffered = len > 0 ? dec.Duration * Math.Min(1.0, (double)t.Source.Downloaded / len) : 0;
            Program.Send("position", "position", pos, "duration", dec.Duration, "buffered", buffered);
        }
    }
}
