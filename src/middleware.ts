import { defineMiddleware } from "astro:middleware";

const PUBLIC_PATHS = ["/login"];

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  if (PUBLIC_PATHS.includes(pathname)) {
    return next();
  }

  const accessToken = context.cookies.get("access_token")?.value;

  if (!accessToken) {
    return context.redirect("/login");
  }

  const response = await next();

  if (response.status === 401) {
    return context.redirect("/login?expired=1");
  }

  return response;
});
