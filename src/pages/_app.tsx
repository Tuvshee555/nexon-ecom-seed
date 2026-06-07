import type { AppProps } from "next/app";
import "@/styles/globals.css";
import { ErrorBoundary, ToastProvider } from "@/components/ui";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <Component {...pageProps} />
      </ToastProvider>
    </ErrorBoundary>
  );
}
