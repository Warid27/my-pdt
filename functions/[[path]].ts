import { handleRequest, type Env } from "../src/index";

export const onRequest: PagesFunction<Env> = ({ request, env }) => {
  return handleRequest(request, env);
};
