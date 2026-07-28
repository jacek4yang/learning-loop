import type { PortableCore } from "./types";

export function portablePathsConflict(
  left: string,
  right: string,
  core: Pick<PortableCore, "collisionKey">,
): boolean {
  const leftKey = core.collisionKey(left);
  const rightKey = core.collisionKey(right);
  return leftKey === rightKey
    || leftKey.startsWith(`${rightKey}/`)
    || rightKey.startsWith(`${leftKey}/`);
}

export function portablePathConflictGroups(
  paths: readonly string[],
  core: Pick<PortableCore, "collisionKey">,
): readonly (readonly string[])[] {
  const pathsByKey = new Map<string, string[]>();
  for (const path of paths) {
    const key = core.collisionKey(path);
    const members = pathsByKey.get(key) ?? [];
    members.push(path);
    pathsByKey.set(key, members);
  }

  const groups = new Map<string, Set<string>>();
  for (const [key, pathsAtKey] of pathsByKey) {
    if (pathsAtKey.length > 1) {
      groups.set(key, new Set(pathsAtKey));
    }
    for (const match of key.matchAll(/\//gu)) {
      const slash = match.index;
      const ancestorKey = key.slice(0, slash);
      const ancestorPaths = pathsByKey.get(ancestorKey);
      if (ancestorPaths === undefined) {
        continue;
      }
      const members = groups.get(ancestorKey) ?? new Set<string>();
      for (const path of [...ancestorPaths, ...pathsAtKey]) {
        members.add(path);
      }
      groups.set(ancestorKey, members);
    }
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, members]) => [...members].sort());
}
