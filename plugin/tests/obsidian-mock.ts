export class TFile {
  readonly basename: string;
  readonly extension: string;

  constructor(readonly path: string) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    this.basename = dot < 0 ? name : name.slice(0, dot);
    this.extension = dot < 0 ? "" : name.slice(dot + 1);
  }
}

export class TFolder {
  constructor(readonly path: string) {}
}

export const Platform = {
  isMobile: false,
  isAndroidApp: false,
  isDesktopApp: true,
};

export function normalizePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replaceAll(/\/+/gu, "/")
    .replace(/^\/|\/$/gu, "");
}
