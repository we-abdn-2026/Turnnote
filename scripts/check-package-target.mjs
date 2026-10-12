const [expectedPlatform, expectedArchitecture] = process.argv.slice(2);

if (process.platform !== expectedPlatform || process.arch !== expectedArchitecture) {
  console.error(
    `This package must be built on ${expectedPlatform}/${expectedArchitecture}; ` +
      `the current host is ${process.platform}/${process.arch}. PyInstaller does not cross-compile.`,
  );
  process.exit(1);
}
