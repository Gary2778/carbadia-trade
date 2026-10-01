import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/portfolio", "/trade/account", "/login", "/register"] },
    sitemap: "https://cbda.trade/sitemap.xml",
  };
}
