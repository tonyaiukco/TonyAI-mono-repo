// Re-export the generated Prisma client so consumers import from "@tonyai/db".
// The NestJS app wraps PrismaClient in its own injectable PrismaService.
export * from "../generated/client";
