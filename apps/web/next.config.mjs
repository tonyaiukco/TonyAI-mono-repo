/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@tonyai/shared-types"],
  images: {
    unoptimized: true,
  },
}

export default nextConfig
