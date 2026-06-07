import { Html, Head, Main, NextScript } from "next/document";

/**
 * Custom document — sets the correct document language so screen readers
 * and search engines render the Mongolian content correctly. This is
 * SSR-rendered, so there is no hydration language flicker.
 */
export default function Document() {
  return (
    <Html lang="mn">
      <Head>
        <meta charSet="utf-8" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
