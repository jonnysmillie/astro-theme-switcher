// @ts-check
import { defineConfig } from "astro/config";
import netlify from "@astrojs/netlify";
import react from "@astrojs/react";
import icon from "astro-icon";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { SITE } from "./src/config/site.mjs";

// https://astro.build/config
export default defineConfig({
  site: SITE.url,
  output: "hybrid", // Allows static pages + API routes on Netlify
  adapter: netlify(),
  integrations: [
    react(),
    icon(),
    mdx(),
    sitemap({
      changefreq: "weekly",
      priority: 0.7,
      lastmod: new Date(),
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
    build: {
      cssMinify: "lightningcss",
      minify: "terser",
      terserOptions: {
        compress: {
          drop_console: false, // Keep console logs for API route debugging
          drop_debugger: true,
        },
      },
    },
  },
  build: {
    inlineStylesheets: "auto",
    assets: "_assets",
  },
  compressHTML: true,
  image: {
    domains: [],
    remotePatterns: [],
  },
});
