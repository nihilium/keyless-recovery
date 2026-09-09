import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider } from '@privy-io/react-auth';
import { SmartWalletsProvider } from '@privy-io/react-auth/smart-wallets';
import './index.css';
import App from './App.tsx';
import { AdminDashboard } from './admin/AdminDashboard.tsx';
import { RecoveryContextProvider } from './recovery/RecoveryContext';
import { SmartAccountProvider } from './smartAccount/SmartAccountContext';
import { PRIVY_APP_ID, isPrivyConfigured } from './auth/login';

const isAdminPath = window.location.pathname.startsWith('/admin');

function Root() {
  if (isAdminPath) return <AdminDashboard />;

  const tree = (
    <SmartAccountProvider>
      <RecoveryContextProvider>
        <App />
      </RecoveryContextProvider>
    </SmartAccountProvider>
  );

  if (!isPrivyConfigured) return tree;

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID as string}
      config={{
        // No `loginMethods` on purpose. Privy renders exactly what's enabled in the Dashboard;
        // hardcoding a list *overrides* that and shows buttons for providers that are switched off,
        // which fails at click time with "Login with X not allowed". Enable a provider in the
        // Dashboard and it appears here automatically — no code change.
        appearance: {
          theme: 'dark',
          accentColor: '#5b8cff',
        },
        embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
      }}
    >
      <SmartWalletsProvider>{tree}</SmartWalletsProvider>
    </PrivyProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

