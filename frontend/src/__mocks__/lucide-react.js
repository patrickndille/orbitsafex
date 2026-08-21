// Minimal lucide-react stub — returns simple span elements.
const React = require("react");
const icon = (name) => (props) =>
  React.createElement("span", { "data-icon": name, ...props });
module.exports = new Proxy(
  {},
  {
    get(_target, name) {
      if (name === "__esModule") return true;
      return icon(name);
    },
  }
);
