import { useEffect, useState } from 'react';
import { createPublicClient, http, formatEther, type Address } from 'viem';
import { sepolia } from 'viem/chains';

const RPC_URL = (import.meta.env.VITE_SEPOLIA_RPC_URL as string | undefined) ?? 'https://ethereum-sepolia-rpc.publicnode.com';

const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });

export function useBalance(address: Address | null) {
  const [balance, setBalance] = useState<string | null>(null);

  useEffect(() => {
    if (!address) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    const read = async () => {
      try {
        const wei = await publicClient.getBalance({ address });
        if (!cancelled) setBalance(formatEther(wei));
      } catch {
        if (!cancelled) setBalance(null);
      }
    };
    read();
    const timer = setInterval(read, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [address]);

  return balance;
}
