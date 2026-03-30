import Head from 'next/head';
import dynamic from 'next/dynamic';

// HlsLutPlayer uses browser APIs (WebGL, HLS.js) — disable SSR
const HlsLutPlayer = dynamic(() => import('@/components/HlsLutPlayer'), { ssr: false });

const HLS_URL =
  'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8';

export default function Home() {
  return (
    <>
      <Head>
        <title>HLS + WebGL CUBE LUT Player</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <main style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
        <h1 style={{ fontFamily: 'monospace', marginBottom: 16 }}>HLS + WebGL CUBE LUT</h1>
        <HlsLutPlayer url={HLS_URL} lutUrl="/BW1.cube" width={1280} height={534} />
      </main>
    </>
  );
}
