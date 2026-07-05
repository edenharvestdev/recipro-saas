// Conditional Option Flow V1 — F0 public surface (pure library; feature OFF by default).
// Navigation + reusable sets + effect-assembly bridge to PR#21. No DB, no stock deduction.
module.exports = {
  ...require('./constants'),
  ...require('./resolver'),
  ...require('./validator'),
  ...require('./effect-assembly'),
  ...require('./snapshot'),
};
