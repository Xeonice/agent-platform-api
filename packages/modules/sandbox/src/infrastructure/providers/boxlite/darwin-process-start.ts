import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// BoxLite 0.9.7 util/process.rs uses this exact kernel fingerprint on Darwin.
// ps/lstart loses microseconds and cannot detect a PID reused within one second.
// ctypes calls the system libproc; no SDK runtime, VM operation or shell is involved.
const READ_PROCESS = `
import ctypes, json, sys
class BsdInfo(ctypes.Structure):
    _fields_ = [
        ("flags", ctypes.c_uint32), ("status", ctypes.c_uint32),
        ("xstatus", ctypes.c_uint32), ("pid", ctypes.c_uint32),
        ("ppid", ctypes.c_uint32), ("uid", ctypes.c_uint32),
        ("gid", ctypes.c_uint32), ("ruid", ctypes.c_uint32),
        ("rgid", ctypes.c_uint32), ("svuid", ctypes.c_uint32),
        ("svgid", ctypes.c_uint32), ("reserved", ctypes.c_uint32),
        ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32),
        ("nfiles", ctypes.c_uint32), ("pgid", ctypes.c_uint32),
        ("jobc", ctypes.c_uint32), ("tty", ctypes.c_uint32),
        ("tty_pgid", ctypes.c_uint32), ("nice", ctypes.c_int32),
        ("start_sec", ctypes.c_uint64), ("start_usec", ctypes.c_uint64)]
pid = int(sys.argv[1])
lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                           ctypes.c_void_p, ctypes.c_int]
lib.proc_pidinfo.restype = ctypes.c_int
info = BsdInfo()
size = ctypes.sizeof(info)
if size != 136 or lib.proc_pidinfo(pid, 3, 0, ctypes.byref(info), size) != size:
    print("null")
elif info.pid != pid or info.status == 5 or info.flags & 4:
    print("null")
else:
    print(json.dumps({"pid": info.pid,
                      "startTime": str(info.start_sec * 1000000 + info.start_usec)}))
`;

export interface DarwinProcessStart {
  pid: number;
  /** Epoch microseconds, compared as an exact decimal string. */
  startTime: string;
}

/** Missing Python, denied kernel reads and exited processes remain unconfirmed. */
export async function readDarwinProcessStart(pid: number): Promise<DarwinProcessStart | null> {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) return null;
  try {
    const { stdout } = await run('/usr/bin/python3', ['-I', '-c', READ_PROCESS, String(pid)], {
      timeout: 2000,
      maxBuffer: 4096,
      encoding: 'utf8',
    });
    const value: unknown = JSON.parse(stdout);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('pid' in value) ||
      value.pid !== pid ||
      !('startTime' in value) ||
      typeof value.startTime !== 'string' ||
      !/^[1-9]\d{0,19}$/.test(value.startTime)
    )
      return null;
    return { pid, startTime: value.startTime };
  } catch {
    return null;
  }
}
