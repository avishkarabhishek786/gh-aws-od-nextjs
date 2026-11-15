export const dynamic = 'force-dynamic';

// On EC2 we read the instance ID and zone from the metadata service (IMDSv2).
async function meta(path) {
  try {
    const token = await fetch('http://169.254.169.254/latest/api/token', {
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' },
      signal: AbortSignal.timeout(1000),
    }).then((r) => r.text());
    return await fetch('http://169.254.169.254/latest/meta-data/' + path, {
      headers: { 'X-aws-ec2-metadata-token': token },
      signal: AbortSignal.timeout(1000),
    }).then((r) => r.text());
  } catch {
    return 'not running on EC2';
  }
}

export default async function Home() {
  const id = await meta('instance-id');
  const az = await meta('placement/availability-zone');
  const version = (process.env.APP_VERSION || 'dev').slice(0, 7);
  return (
    <main style={{ fontFamily: 'sans-serif', padding: 40 }}>
      <h1>Acme Status v2</h1>
      <p>Version: <b>{version}</b></p>
      <p>Served by instance: <b>{id}</b></p>
      <p>Availability Zone: <b>{az}</b></p>
    </main>
  );
}