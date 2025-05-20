import { spawn } from "node:child_process";
import chalk from "chalk";
import path from "node:path";
import fs from "node:fs";
import CharacterSet from "characterset";

/**
 * Uses the system which command to check if a given command exists in the users' path.
 * This is of course linux/unix specific and will need updating if this is deployed on
 * a windows box... or there might be a node built in I am unaware of that does this??
 *
 * @param command {string}
 * @returns {Promise<boolean>}
 */
function checkCommandExists(command) {
  return new Promise((resolve) => {
    const processCheck = spawn("which", [command]);
    processCheck.on("exit", (code) => resolve(code === 0));
  });
}

/**
 * Checks if pyftsubset command exists and is executable.
 *
 * @returns {Promise<boolean>}
 */
function checkPyftsubset() {
  return new Promise((resolve) => {
    // Try executing, resolve promise based on exit code or spawn error
    spawn("pyftsubset", ["--version"])
      .on("error", () => resolve(false))
      .on("exit", (code) => resolve(code === 0));
  });
}

const rootPath = (p) => path.resolve(process.env.ELEVENTY_ROOT, p);

const memoryCache = new Map();

/**
 *
 * @param { import('@11ty/eleventy/src/UserConfig') } eleventyConfig
 * @param { import('@photogabble/eleventy-plugin-font-subsetting').EleventyPluginFontSubsettingOptions } options
 */
export default function (eleventyConfig, options) {
  /** @var { import('@photogabble/eleventy-plugin-font-subsetting').EleventyPluginFontSubsettingOptions } opts */
  const opts = Object.assign(
    {
      dist: null,
      enabled: true,
      srcFiles: [],
      cache: {
        get: (key) => memoryCache.get(key),
        set: (key, value) => memoryCache.set(key, value),
        has: (key) => memoryCache.has(key),
      },
      cacheKey: "font-subsetting",
      quiet: false,
    },
    options,
  );

  if (opts.dist) eleventyConfig.addPassthroughCopy(opts.dist);
  if (opts.enabled === false) return;

  const glyphs = {
    chars: new Set(),
    add(text) {
      for (let char of text) {
        if ([" ", "\n", "\r", "\t"].includes(char) === false)
          this.chars.add(char);
      }
    },
    getUnique() {
      const out = Array.from(this.chars);
      out.sort();
      return out.join("");
    },
  };

  eleventyConfig.addTransform("identifyGlyphs", (content, outputPath) => {
    if (outputPath.endsWith(".html")) glyphs.add(content);
    return content;
  });

  eleventyConfig.on("eleventy.after", async () => {
    const cachedUnicodeHexRange = opts.cache.get("cs");
    const cs = new CharacterSet.default(glyphs.getUnique());
    const unicodeHexRange = cs.toHexRangeString();
    const rootDist = opts.dist ? rootPath(opts.dist) : false;
    let srcFiles = (opts.srcFiles ?? []).map((src) => {
      const info = path.parse(src);
      const dir = rootDist ? rootDist : info.dir;

      return {
        src: rootPath(src),
        dist: `${dir}/${info.name}.subset${info.ext}`,
      };
    });

    // If we have a cached unicode hex range that's identical to what has been discovered then we do not need to
    // rebuild the font files unless a subset font file is missing.
    if (cachedUnicodeHexRange && cachedUnicodeHexRange === unicodeHexRange) {
      srcFiles = srcFiles.filter((file) => fs.existsSync(file.dist) === false);

      if (srcFiles.length === 0) {
        console.log(
          chalk.blue("[@photogabble/subsetter]"),
          chalk.green("[OK]"),
          "Matching cached charset found, not rebuilding fonts",
        );
        return;
      }
    }

    console.log(
      chalk.blue("[@photogabble/subsetter]"),
      `Identified ${glyphs.chars.size} unique glyphs in use, creating subset`,
    );
    console.log(
      chalk.blue("[@photogabble/subsetter]"),
      "Codepoint Range:",
      unicodeHexRange,
    );
    console.log(
      chalk.blue("[@photogabble/subsetter]"),
      `Subsetting ${srcFiles.length} font files.`,
    );

    // If we must run, first check if pyftsubset is available in our path
    if ((await checkPyftsubset()) === false) {
      console.log(
        chalk.blue("[@photogabble/subsetter]"),
        chalk.red("[ERROR]"),
        'Unable to locate pyftsubset, please install via "pip install fonttools"',
      );
      return;
    }

    const promises = [];
    for (const file of srcFiles) {
      promises.push(
        new Promise((resolve, reject) => {
          console.log(
            chalk.blue("[@photogabble/subsetter]"),
            chalk.yellow("[..]"),
            `Processing: ${file.src}`,
          );
          const buildProcess = spawn(
            "pyftsubset",
            [
              file.src,
              `--output-file=${file.dist}`,
              `--unicodes=${unicodeHexRange}`,
              "--flavor=woff2",
            ],
            { stdio: opts.quiet ? "ignore" : "inherit" },
          );

          // Reject promise if spawn fails
          buildProcess.on("error", reject);

          // Resolve/reject promise based on exit code
          buildProcess.on("close", (code) => {
            if (code === 0) {
              console.log(
                chalk.blue("[@photogabble/subsetter]"),
                chalk.green("[OK]"),
                `Saved: ${file.dist}`,
              );
              resolve();
            } else {
              reject(
                new Error(
                  `pyftsubset failed for ${file.src} with exit code ${code}`,
                ),
              );
            }
          });
        }),
      );
    }

    // Let Promise.all handle potential rejections
    await Promise.all(promises);

    // Cache unicode hex range for 10 years (forever...)
    opts.cache.set("cs", unicodeHexRange, 86400 * 365 * 10);

    console.log(
      chalk.blue("[@photogabble/subsetter]"),
      chalk.green("[OK]"),
      `Complete`,
    );
  });
}
