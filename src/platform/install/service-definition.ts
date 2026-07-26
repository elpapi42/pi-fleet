import { isAbsolute } from "node:path";

export interface ServiceDefinitionOptions {
  readonly nodePath: string;
  readonly runtimePath: string;
  readonly piExecutablePath?: string;
  readonly piNodePath?: string;
  readonly stateRoot?: string;
}

export function systemdUserUnit(options: ServiceDefinitionOptions): string {
  validate(options);
  const environment = environmentEntries(options)
    .map(([key, value]) => {
      const assignment = `${key}=${value}`;
      return `Environment=${/^[A-Za-z0-9_./:@=-]+$/.test(assignment) ? assignment : systemdQuote(assignment)}\n`;
    })
    .join("");
  return `[Unit]
Description=pi-fleet user runtime
After=default.target

[Service]
Type=simple
ExecStart=${systemdArgument(options.nodePath)} ${systemdArgument(options.runtimePath)}
${environment}Restart=on-failure
RestartSec=1
TimeoutStopSec=10
UMask=0077
KillMode=control-group

[Install]
WantedBy=default.target
`;
}

export function launchdAgentPlist(options: ServiceDefinitionOptions): string {
  validate(options);
  const entries = environmentEntries(options);
  const environment =
    entries.length === 0
      ? ""
      : `    <key>EnvironmentVariables</key>
    <dict>${entries
      .map(([key, value]) => `<key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`)
      .join("")}</dict>
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>works.elpapi.pifleet</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xmlEscape(options.nodePath)}</string>
        <string>${xmlEscape(options.runtimePath)}</string>
    </array>
${environment}    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
    <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

function environmentEntries(options: ServiceDefinitionOptions): Array<readonly [string, string]> {
  return [
    ...(options.stateRoot === undefined
      ? []
      : [["PIFLEET_STATE_ROOT", options.stateRoot] as const]),
    ...(options.piExecutablePath === undefined
      ? []
      : [["PIFLEET_PI_EXECUTABLE", options.piExecutablePath] as const]),
    ...(options.piNodePath === undefined ? [] : [["PIFLEET_PI_NODE", options.piNodePath] as const]),
  ];
}

function validate(options: ServiceDefinitionOptions): void {
  const paths = [
    options.nodePath,
    options.runtimePath,
    options.piExecutablePath,
    options.piNodePath,
  ].filter((value): value is string => value !== undefined);
  if (paths.some((path) => !isAbsolute(path))) {
    throw new Error("Service executables must use absolute paths");
  }
  if (paths.some((path) => /[\0\n\r]/.test(path))) {
    throw new Error("Service paths cannot contain control characters");
  }
}

function systemdArgument(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : systemdQuote(value);
}

function systemdQuote(value: string): string {
  if (/[\0\n\r]/.test(value)) throw new Error("Unsafe systemd value");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
