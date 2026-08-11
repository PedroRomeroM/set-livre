import { describe, expect, it } from "vitest";

import { createBrowserProcessEnvironment } from "../helpers/browser-process-environment";

describe("Playwright browser process environment", () => {
  it("preserves only the operational POSIX variables needed by browser engines", () => {
    expect(
      createBrowserProcessEnvironment({
        CI: "1",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        DISPLAY: ":1",
        HOME: "/home/tester",
        LANG: "pt_BR.UTF-8",
        LC_ALL: "C.UTF-8",
        LC_TIME: "pt_BR.UTF-8",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        TERM: "xterm-256color",
        TMPDIR: "/tmp",
        TZ: "America/Sao_Paulo",
        WAYLAND_DISPLAY: "wayland-0",
        XAUTHORITY: "/run/user/1000/xauth",
        XDG_RUNTIME_DIR: "/run/user/1000",
      }),
    ).toEqual({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/home/tester",
      TMPDIR: "/tmp",
      LANG: "pt_BR.UTF-8",
      LC_ALL: "C.UTF-8",
      LC_TIME: "pt_BR.UTF-8",
      TZ: "America/Sao_Paulo",
      CI: "1",
      TERM: "xterm-256color",
      DISPLAY: ":1",
      WAYLAND_DISPLAY: "wayland-0",
      XAUTHORITY: "/run/user/1000/xauth",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
  });

  it("preserves the minimum Windows process variables without broad user configuration", () => {
    expect(
      createBrowserProcessEnvironment({
        APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
        Path: "C:\\Windows\\System32;C:\\Program Files\\Browser",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        SystemRoot: "C:\\Windows",
        TEMP: "C:\\Users\\tester\\AppData\\Local\\Temp",
        USERPROFILE: "C:\\Users\\tester",
        WINDIR: "C:\\Windows",
      }),
    ).toEqual({
      Path: "C:\\Windows\\System32;C:\\Program Files\\Browser",
      USERPROFILE: "C:\\Users\\tester",
      TEMP: "C:\\Users\\tester\\AppData\\Local\\Temp",
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    });
  });

  it("never forwards credentials, database, SSH, package-manager, loader or runtime injection", () => {
    expect(
      createBrowserProcessEnvironment({
        AWS_SECRET_ACCESS_KEY: "cloud-secret",
        DATABASE_URL_APP_DAL: "postgresql://runtime:secret@127.0.0.1/database",
        DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
        E2E_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1/postgres",
        GITHUB_TOKEN: "github-secret",
        LD_LIBRARY_PATH: "/tmp/host-libraries",
        NODE_AUTH_TOKEN: "registry-secret",
        NODE_OPTIONS: "--require=/tmp/inject.cjs",
        NPM_TOKEN: "npm-secret",
        PGPASSWORD: "database-secret",
        PGUSER: "postgres",
        SNAP: "/snap/code/current",
        SNAP_NAME: "code",
        SSH_AGENT_PID: "1234",
        SSH_AUTH_SOCK: "/run/user/1000/ssh-agent.sock",
        npm_config_userconfig: "/home/tester/.npmrc",
      }),
    ).toEqual({});
  });

  it("removes Snap path entries and drops operational values tied to a Snap runtime", () => {
    expect(
      createBrowserProcessEnvironment({
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/snap.code/bus",
        HOME: "/home/tester/snap/code/current",
        PATH: "/snap/bin:/usr/local/bin:/var/lib/snapd/snap/code/current/bin:/usr/bin",
        Path: "C:\\Snap\\bin;C:\\Windows\\System32",
        XAUTHORITY: "/snap/code/current/.Xauthority",
        XDG_RUNTIME_DIR: "/run/user/1000/snap.code",
      }),
    ).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
      Path: "C:\\Windows\\System32",
    });
  });

  it("omits empty values, unsafe current-directory path entries and lookalike locale secrets", () => {
    expect(
      createBrowserProcessEnvironment({
        HOME: "",
        LC_API_TOKEN: "locale-lookalike-secret",
        LC_CTYPE: "C.UTF-8",
        PATH: ":/usr/bin::/bin:",
        TERM: undefined,
      }),
    ).toEqual({
      PATH: "/usr/bin:/bin",
      LC_CTYPE: "C.UTF-8",
    });
  });
});
