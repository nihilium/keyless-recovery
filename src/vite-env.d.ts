/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PRIVY_APP_ID?: string;
  /** "fictive" (default) or "nihilium" — see src/recovery/RecoveryContext.tsx. */
  readonly VITE_RECOVERY_PROVIDER?: 'fictive' | 'nihilium';
  readonly VITE_RECOVERY_BACKEND_URL?: string;
  readonly VITE_SEPOLIA_RPC_URL?: string;
  readonly VITE_NIHILIUM_API_KEY?: string;
  readonly VITE_NIHILIUM_API_URL?: string;
  readonly VITE_NIHILIUM_EMAIL_SERVICE_URL?: string;
  readonly VITE_NIHILIUM_THRESHOLD?: string;
  readonly VITE_NIHILIUM_PROCESSOR_COUNT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
