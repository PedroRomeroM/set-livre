using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class SetLivreWindowsJobObjectGuardian
{
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint Infinite = 0xFFFFFFFF;
    private const int JobObjectExtendedLimitInformationClass = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint StartfUseStdHandles = 0x00000100;
    private const int StdInputHandle = -10;
    private const int StdOutputHandle = -11;
    private const int StdErrorHandle = -12;

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JobObjectExtendedLimitInformation information,
        uint informationLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("msvcrt.dll", CallingConvention = CallingConvention.Cdecl, SetLastError = true)]
    private static extern IntPtr _get_osfhandle(int fileDescriptor);

    private static string QuoteArgument(string value)
    {
        if (value.Length != 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return value;
        }

        StringBuilder result = new StringBuilder();
        result.Append('"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes += 1;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes);
            backslashes = 0;
            result.Append(character);
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static StringBuilder BuildCommandLine(string[] arguments, int offset)
    {
        StringBuilder commandLine = new StringBuilder();
        for (int index = offset; index < arguments.Length; index += 1)
        {
            if (index != offset)
            {
                commandLine.Append(' ');
            }
            commandLine.Append(QuoteArgument(arguments[index]));
        }
        return commandLine;
    }

    private static void ThrowLastWin32Error(string operation)
    {
        throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    public static int Main(string[] arguments)
    {
        const string controlArgument = "--control-fd=3";
        if (arguments.Length < 2 || arguments[0] != controlArgument)
        {
            Console.Error.WriteLine("guardian: control descriptor and target executable are required");
            return 64;
        }

        IntPtr job = IntPtr.Zero;
        SafeFileHandle jobOwner = null;
        FileStream parentControl = null;
        ProcessInformation child = new ProcessInformation();
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
            {
                ThrowLastWin32Error("CreateJobObjectW failed");
            }
            jobOwner = new SafeFileHandle(job, true);

            JobObjectExtendedLimitInformation limits = new JobObjectExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            uint limitsSize = checked((uint)Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation)));
            if (!SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformationClass,
                ref limits,
                limitsSize))
            {
                ThrowLastWin32Error("SetInformationJobObject failed");
            }

            IntPtr controlHandle = _get_osfhandle(3);
            if (controlHandle == new IntPtr(-1))
            {
                ThrowLastWin32Error("guardian control descriptor is unavailable");
            }
            parentControl = new FileStream(
                new SafeFileHandle(controlHandle, false),
                FileAccess.Read,
                1,
                false);
            if (parentControl.ReadByte() != 1)
            {
                throw new InvalidOperationException("guardian parent handshake failed");
            }

            FileStream controlForMonitor = parentControl;
            SafeFileHandle jobForMonitor = jobOwner;
            Thread monitor = new Thread(delegate()
            {
                try
                {
                    while (controlForMonitor.ReadByte() != -1)
                    {
                    }
                }
                catch
                {
                }
                finally
                {
                    jobForMonitor.Close();
                }
            });
            monitor.IsBackground = true;
            monitor.Start();

            StartupInfo startup = new StartupInfo();
            startup.cb = checked((uint)Marshal.SizeOf(typeof(StartupInfo)));
            startup.dwFlags = StartfUseStdHandles;
            startup.hStdInput = GetStdHandle(StdInputHandle);
            startup.hStdOutput = GetStdHandle(StdOutputHandle);
            startup.hStdError = GetStdHandle(StdErrorHandle);
            StringBuilder commandLine = BuildCommandLine(arguments, 1);
            if (!CreateProcess(
                arguments[1],
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CreateSuspended | CreateUnicodeEnvironment,
                IntPtr.Zero,
                null,
                ref startup,
                out child))
            {
                ThrowLastWin32Error("CreateProcessW failed");
            }
            if (!AssignProcessToJobObject(job, child.hProcess))
            {
                int assignmentError = Marshal.GetLastWin32Error();
                TerminateProcess(child.hProcess, 1);
                WaitForSingleObject(child.hProcess, Infinite);
                throw new Win32Exception(assignmentError, "AssignProcessToJobObject failed");
            }
            if (ResumeThread(child.hThread) == uint.MaxValue)
            {
                int resumeError = Marshal.GetLastWin32Error();
                TerminateProcess(child.hProcess, 1);
                WaitForSingleObject(child.hProcess, Infinite);
                throw new Win32Exception(resumeError, "ResumeThread failed");
            }
            CloseHandle(child.hThread);
            child.hThread = IntPtr.Zero;

            if (WaitForSingleObject(child.hProcess, Infinite) != 0)
            {
                ThrowLastWin32Error("WaitForSingleObject failed");
            }
            uint exitCode;
            if (!GetExitCodeProcess(child.hProcess, out exitCode))
            {
                ThrowLastWin32Error("GetExitCodeProcess failed");
            }
            return exitCode <= 255 ? checked((int)exitCode) : 1;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
        finally
        {
            if (child.hThread != IntPtr.Zero)
            {
                CloseHandle(child.hThread);
            }
            if (child.hProcess != IntPtr.Zero)
            {
                CloseHandle(child.hProcess);
            }
            if (jobOwner != null)
            {
                jobOwner.Close();
            }
            if (parentControl != null)
            {
                parentControl.Close();
            }
        }
    }
}
