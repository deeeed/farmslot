/** Decode the field arguments shared by the publication provider fixtures. */
function parseGhFields(args) {
  return Object.fromEntries(
    args
      .filter((value) => /^[a-zA-Z0-9_]+=/.test(value))
      .map((value) => {
        const split = value.indexOf('=');
        return [value.slice(0, split), value.slice(split + 1)];
      }),
  );
}

module.exports.parseGhFields = parseGhFields;
