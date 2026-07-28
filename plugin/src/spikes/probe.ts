export const TRANSPORT_PROBE = new Uint8Array([
  0x00, 0x01, 0x02, 0x7f, 0x80, 0xfe, 0xff, 0x4c, 0x4c, 0x50, 0x31,
]);

export function probeMatches(received: ArrayBuffer): boolean {
  const actual = new Uint8Array(received);
  return (
    actual.length === TRANSPORT_PROBE.length &&
    actual.every((value, index) => value === TRANSPORT_PROBE[index])
  );
}
