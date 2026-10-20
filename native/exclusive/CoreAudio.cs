// Minimal Windows Core Audio (MMDevice + WASAPI) interop, adapted from SoDaPlayer's CoreAudio.cs.
// C# 5 (the compiler that ships with .NET Framework 4.x), no external dependencies.
using System;
using System.Runtime.InteropServices;

namespace GameSong.Exclusive
{
    internal enum EDataFlow { Render = 0, Capture = 1, All = 2 }
    internal enum ERole { Console = 0, Multimedia = 1, Communications = 2 }
    internal enum ShareMode { Shared = 0, Exclusive = 1 }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PropertyKey
    {
        public Guid FormatId;
        public int PropertyId;
        public PropertyKey(Guid formatId, int propertyId) { FormatId = formatId; PropertyId = propertyId; }
    }

    // 24 bytes covers PROPVARIANT on both x86 and x64.
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    internal struct PropVariant
    {
        [FieldOffset(0)] public ushort VarType;
        [FieldOffset(8)] public IntPtr Pointer;
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(EDataFlow dataFlow, uint stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, uint clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        [PreserveSig] int OpenPropertyStore(uint stgmAccess, out IPropertyStore properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out uint state);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioClient
    {
        [PreserveSig] int Initialize(ShareMode shareMode, uint streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint bufferFrames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint paddingFrames);
        [PreserveSig] int IsFormatSupported(ShareMode shareMode, IntPtr pFormat, IntPtr ppClosestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr deviceFormat);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioRenderClient
    {
        [PreserveSig] int GetBuffer(uint numFramesRequested, out IntPtr data);
        [PreserveSig] int ReleaseBuffer(uint numFramesWritten, uint flags);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioEndpointVolume
    {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
        [PreserveSig] int GetChannelCount(out uint count);
        [PreserveSig] int SetMasterVolumeLevel(float levelDb, ref Guid eventContext);
        [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
        [PreserveSig] int GetMasterVolumeLevel(out float levelDb);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
        [PreserveSig] int SetChannelVolumeLevel(uint channel, float levelDb, ref Guid eventContext);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid eventContext);
        [PreserveSig] int GetChannelVolumeLevel(uint channel, out float levelDb);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
        [PreserveSig] int GetVolumeStepInfo(out uint step, out uint stepCount);
        [PreserveSig] int VolumeStepUp(ref Guid eventContext);
        [PreserveSig] int VolumeStepDown(ref Guid eventContext);
        [PreserveSig] int QueryHardwareSupport(out uint hardwareSupportMask);
        [PreserveSig] int GetVolumeRange(out float minDb, out float maxDb, out float incrementDb);
    }

    internal static class NativeMethods
    {
        [DllImport("ole32.dll")]
        public static extern int PropVariantClear(ref PropVariant pvar);

        [DllImport("avrt.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr AvSetMmThreadCharacteristics(string taskName, ref uint taskIndex);

        [DllImport("avrt.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool AvRevertMmThreadCharacteristics(IntPtr handle);
    }

    internal static class Wasapi
    {
        public const uint CLSCTX_ALL = 0x17;
        public const uint DEVICE_STATE_ACTIVE = 0x1;
        public const uint STREAMFLAGS_EVENTCALLBACK = 0x00040000;

        public const int S_OK = 0;
        public const int E_UNSUPPORTED_FORMAT = unchecked((int)0x88890008);
        public const int E_DEVICE_INVALIDATED = unchecked((int)0x88890004);
        public const int E_DEVICE_IN_USE = unchecked((int)0x8889000A);
        public const int E_EXCLUSIVE_MODE_NOT_ALLOWED = unchecked((int)0x8889000E);
        public const int E_BUFFER_SIZE_ERROR = unchecked((int)0x88890016);
        public const int E_BUFFER_SIZE_NOT_ALIGNED = unchecked((int)0x88890019);
        public const int E_INVALID_DEVICE_PERIOD = unchecked((int)0x88890020);

        public static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
        public static readonly Guid IID_IAudioRenderClient = new Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2");
        public static readonly Guid IID_IAudioEndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");

        public static string Describe(int hr)
        {
            switch (hr)
            {
                case E_UNSUPPORTED_FORMAT: return "the device doesn't support this format in exclusive mode";
                case E_DEVICE_INVALIDATED: return "the audio device was removed or reconfigured";
                case E_DEVICE_IN_USE: return "another app is already using the device in exclusive mode";
                case E_EXCLUSIVE_MODE_NOT_ALLOWED:
                    return "exclusive mode is turned off for this device (Sound settings > device Properties > Advanced > " +
                           "allow applications to take exclusive control)";
                case E_BUFFER_SIZE_ERROR: return "the driver doesn't support the requested buffer size";
                case E_INVALID_DEVICE_PERIOD: return "the driver doesn't support the requested device period";
                default: return "HRESULT 0x" + hr.ToString("X8");
            }
        }

        /// <summary>Short machine-readable reason for the app (it decides how to explain / fall back).</summary>
        public static string Code(int hr)
        {
            switch (hr)
            {
                case E_UNSUPPORTED_FORMAT: return "unsupported";
                case E_DEVICE_IN_USE: return "busy";
                case E_EXCLUSIVE_MODE_NOT_ALLOWED: return "notallowed";
                case E_DEVICE_INVALIDATED: return "device";
                default: return "device";
            }
        }

        public static void Check(int hr, string what)
        {
            if (hr < 0) throw new AudioException(what + " failed: " + Describe(hr), hr);
        }

        public static void Release(object comObject)
        {
            if (comObject == null) return;
            try { Marshal.ReleaseComObject(comObject); } catch { }
        }

        public static IAudioClient ActivateAudioClient(IMMDevice device)
        {
            Guid iid = IID_IAudioClient;
            object o;
            Check(device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o), "IMMDevice.Activate(IAudioClient)");
            return (IAudioClient)o;
        }

        static readonly PropertyKey PKEY_Device_FriendlyName = new PropertyKey(new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), 14);

        /// <summary>The Windows default playback device (Multimedia role).</summary>
        public static IMMDevice DefaultDevice()
        {
            var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            try
            {
                IMMDevice dev;
                Check(en.GetDefaultAudioEndpoint(EDataFlow.Render, ERole.Multimedia, out dev), "GetDefaultAudioEndpoint");
                return dev;
            }
            finally { Release(en); }
        }

        public static string FriendlyName(IMMDevice device)
        {
            IPropertyStore store;
            if (device.OpenPropertyStore(0, out store) != 0 || store == null) return "Audio device";
            try
            {
                PropertyKey key = PKEY_Device_FriendlyName;
                PropVariant pv;
                if (store.GetValue(ref key, out pv) != 0) return "Audio device";
                try { return pv.VarType == 31 && pv.Pointer != IntPtr.Zero ? Marshal.PtrToStringUni(pv.Pointer) : "Audio device"; }
                finally { NativeMethods.PropVariantClear(ref pv); }
            }
            finally { Release(store); }
        }
    }

    internal sealed class AudioException : Exception
    {
        public readonly int HResult2;
        public AudioException(string message, int hr) : base(message) { HResult2 = hr; }
    }

    /// <summary>Endpoint (device) volume. On DACs with a hardware volume control this is applied in the DAC, so the stream stays bit-perfect.</summary>
    internal sealed class EndpointVolume : IDisposable
    {
        IAudioEndpointVolume volume;
        public readonly bool Hardware;

        public EndpointVolume(IMMDevice device)
        {
            Guid iid = Wasapi.IID_IAudioEndpointVolume;
            object o;
            Wasapi.Check(device.Activate(ref iid, Wasapi.CLSCTX_ALL, IntPtr.Zero, out o), "Activate(IAudioEndpointVolume)");
            volume = (IAudioEndpointVolume)o;
            uint mask;
            if (volume.QueryHardwareSupport(out mask) == 0) Hardware = (mask & 1) != 0;
        }

        public float Level
        {
            get { float f; return volume != null && volume.GetMasterVolumeLevelScalar(out f) == 0 ? f : 1f; }
            set
            {
                if (volume == null) return;
                Guid ctx = Guid.Empty;
                volume.SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, value)), ref ctx);
            }
        }

        public void Dispose() { Wasapi.Release(volume); volume = null; }
    }
}
