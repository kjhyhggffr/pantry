/** @type {import('next').NextConfig} */
const nextConfig = {
  // Nothing here is worth caching: every page reads live data from the
  // database, and the routes opt out individually with `dynamic = 'force-dynamic'`.
  reactStrictMode: true,
};

export default nextConfig;
