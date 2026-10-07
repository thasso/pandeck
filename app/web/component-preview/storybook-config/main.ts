import { resolve } from "node:path";
import type { StorybookConfig } from "@storybook/react-vite";
import tailwindcss from "@tailwindcss/vite";

const config: StorybookConfig = {
  stories: ["../stories/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-a11y"],
  framework: {
    name: "@storybook/react-vite",
    options: {
      builder: {
        viteConfigPath: resolve(import.meta.dirname, "../vite.config.ts"),
      },
    },
  },
  async viteFinal(viteConfig) {
    viteConfig.plugins ??= [];
    viteConfig.plugins.push(tailwindcss());
    viteConfig.resolve ??= {};
    viteConfig.resolve.alias = [
      {
        find: /^@\//,
        replacement: `${resolve(import.meta.dirname, "../../src")}/`,
      },
      ...(Array.isArray(viteConfig.resolve.alias)
        ? viteConfig.resolve.alias
        : Object.entries(viteConfig.resolve.alias ?? {}).map(
            ([find, replacement]) => ({ find, replacement }),
          )),
    ];
    return viteConfig;
  },
};

export default config;
