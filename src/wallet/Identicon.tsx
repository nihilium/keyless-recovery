// Deterministic gradient avatar from an address — every account gets a recognisable colour, which
// is what makes "this is a different account now" legible at a glance after simulating loss.

function hashAddress(address: string): number {
  let hash = 0;
  for (let i = 2; i < address.length; i++) {
    hash = (hash * 31 + address.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function Identicon({ address, size = 40 }: { address: string; size?: number }) {
  const hash = hashAddress(address);
  const hueA = hash % 360;
  const hueB = (hueA + 60 + (hash % 90)) % 360;
  const angle = hash % 360;

  return (
    <span
      className="identicon"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(${angle}deg, hsl(${hueA} 70% 55%), hsl(${hueB} 75% 45%))`,
      }}
    />
  );
}

export function truncateAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 2) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}
