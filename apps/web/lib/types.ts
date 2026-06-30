// Canonical domain & API types live in the shared workspace package so that the
// Next.js frontend and the NestJS backend share a single source of truth.
// Import from "@/lib/types" continues to work across the existing UI code.
export * from "@tonyai/shared-types";
