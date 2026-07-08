import { handleRequest, type Env, type ExecutionContextLike } from "../src/index";

export const onRequest: PagesFunction<Env> = (context) => {
  const ctx: ExecutionContextLike = {
    waitUntil: (promise) => context.waitUntil(promise),
  };

  return handleRequest(context.request, context.env, ctx);
};
