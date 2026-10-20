// gs-exclusive.exe — GameSong's WASAPI exclusive-mode FLAC player.
//
// Protocol: one JSON object per line.
//   stdin  (commands): {"cmd":"load","id":7,"url":"https://…flac","start":0,"autoplay":true}
//                      {"cmd":"play"} {"cmd":"pause"} {"cmd":"seek","position":12.5}
//                      {"cmd":"stop"} {"cmd":"quit"}
//                      System volume (default device): {"cmd":"getvolume"} {"cmd":"volume","value":0.6} {"cmd":"mute","value":true}
//   stdout (events):   {"event":"ready","duration":…,"source":"16-bit / 44.1 kHz FLAC","format":…,"device":…,"volume":…,"hardwareVolume":…}
//                      {"event":"state","state":"playing|paused|stopped"} {"event":"position",…}
//                      {"event":"volume","level":0.42,"muted":false}   (at start, on request, and whenever it changes)
//                      {"event":"seeked",…} {"event":"ended"} {"event":"error","code":"notallowed|busy|unsupported|device|decode|network","message":…}
// The process exits when stdin closes (i.e. when GameSong quits).
//
// Self-tests: gs-exclusive.exe --decode <url> <out.raw> [startSample]   writes interleaved s32le PCM (compare with ffmpeg -f s32le)
//             gs-exclusive.exe --probe <url>              opens the device exclusively for the file and reports the format
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace GameSong.Exclusive
{
    internal static class Program
    {
        static readonly object outLock = new object();
        static readonly JavaScriptSerializer json = new JavaScriptSerializer();

        /// <summary>Writes one event line: Send("ready", "key", value, "key2", value2, …).</summary>
        public static void Send(string ev, params object[] kv)
        {
            var d = new Dictionary<string, object> { { "event", ev } };
            for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
            string line = json.Serialize(d);
            lock (outLock) { Console.Out.WriteLine(line); Console.Out.Flush(); }
        }

        [MTAThread]
        static int Main(string[] args)
        {
            try { ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)12288; } // TLS 1.2 + 1.3
            catch { ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; }
            Console.OutputEncoding = new UTF8Encoding(false);

            if (args.Length >= 3 && args[0] == "--decode")
                return Decode(args[1], args[2], args.Length >= 4 ? long.Parse(args[3]) : 0);
            if (args.Length >= 2 && args[0] == "--probe") return Probe(args[1]);

            var player = new Player();
            var systemVolume = new SystemVolume();
            Send("hello", "version", 2);
            systemVolume.Start();
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                Dictionary<string, object> cmd;
                try { cmd = json.Deserialize<Dictionary<string, object>>(line); }
                catch { continue; }
                if (cmd == null || !cmd.ContainsKey("cmd")) continue;
                try
                {
                    switch ((string)cmd["cmd"])
                    {
                        case "load":
                            {
                                string url = (string)cmd["url"];
                                double start = Num(cmd, "start", 0);
                                bool autoplay = !cmd.ContainsKey("autoplay") || (bool)cmd["autoplay"];
                                object id = cmd.ContainsKey("id") ? cmd["id"] : null;   // echoed in "ready" / "error"
                                // Loading waits on the network and the device: keep reading commands meanwhile.
                                new Thread(() => player.Load(url, start, autoplay, id)) { IsBackground = true, Name = "load" }.Start();
                                break;
                            }
                        case "play": player.Play(); break;
                        case "pause": player.Pause(); break;
                        case "seek": player.Seek(Num(cmd, "position", 0)); break;
                        case "getvolume": systemVolume.Poll(true); break;
                        case "volume": systemVolume.Set((float)Num(cmd, "value", 1)); break;
                        case "mute": systemVolume.SetMuted(cmd.ContainsKey("value") && (bool)cmd["value"]); break;
                        case "stop": player.Stop(); break;
                        case "quit": player.Stop(); return 0;
                    }
                }
                catch (Exception e) { Send("error", "code", "internal", "message", e.Message); }
            }
            player.Stop();
            return 0;
        }

        static double Num(Dictionary<string, object> d, string k, double def)
        {
            object v;
            if (!d.TryGetValue(k, out v) || v == null) return def;
            return Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture);
        }

        static int Decode(string url, string outPath, long startSample)
        {
            using (var src = new HttpSource(url))
            {
                var dec = new FlacDecoder(src);
                if (startSample > 0) dec.SeekTo(startSample);
                Console.WriteLine("{0} Hz, {1} ch, {2}-bit, {3} samples", dec.SampleRate, dec.Channels, dec.BitsPerSample, dec.TotalSamples);
                var frame = new int[FlacDecoder.MaxFrameSamples * dec.Channels];
                var bytes = new byte[frame.Length * 4];
                long total = 0;
                var sw = System.Diagnostics.Stopwatch.StartNew();
                using (var fs = File.Create(outPath))
                {
                    int n;
                    while ((n = dec.DecodeFrame(frame)) > 0)
                    {
                        Buffer.BlockCopy(frame, 0, bytes, 0, n * dec.Channels * 4);
                        fs.Write(bytes, 0, n * dec.Channels * 4);
                        total += n;
                    }
                }
                Console.WriteLine("decoded {0} frames in {1} ms", total, sw.ElapsedMilliseconds);
            }
            return 0;
        }

        static int Probe(string url)
        {
            using (var src = new HttpSource(url))
            {
                var dec = new FlacDecoder(src);
                try
                {
                    using (var s = Session.Open(PcmFormat.Candidates(dec.SampleRate, dec.Channels, dec.BitsPerSample)))
                        Console.WriteLine("OK: {0} on \"{1}\" (buffer {2} frames, hardware volume: {3})", s.Format.Describe(), s.DeviceName, s.BufferFrames, s.Volume != null && s.Volume.Hardware);
                    return 0;
                }
                catch (AudioException e) { Console.WriteLine("FAILED ({0}): {1}", Wasapi.Code(e.HResult2), e.Message); return 2; }
            }
        }
    }
}
