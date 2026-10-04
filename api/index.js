// Vercel entry point. vercel.json rewrites every path here and passes it as ?__p=
const { handler } = require("../lib/mock");
module.exports = (req, res) => handler(req, res);
