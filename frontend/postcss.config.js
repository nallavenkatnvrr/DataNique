import twProperties from "./postcss-tw-properties.js";

export default {
  plugins: [
    (await import("tailwindcss")).default(),
    (await import("autoprefixer")).default(),
    twProperties(),
  ],
};
