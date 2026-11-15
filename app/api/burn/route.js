export const dynamic = 'force-dynamic';

export async function GET() {
  const end = Date.now() + 300;
  while (Date.now() < end) {
    Math.sqrt(Math.random());
  }
  return Response.json({ burned: '300ms' });
}