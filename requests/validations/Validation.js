const Validator = require('validatorjs');
const Models = require("../../models");

const validator = async (body, rules, customMessages, callback) => {
  const validation = new Validator(body, rules, customMessages);
  validation.passes(() => callback(null, true));
  validation.fails(() => callback(validation.errors, false));
};

Validator.registerAsync('exist', function(value, attribute, req, passes) {
  if (!attribute) throw new Error('Specify Requirements i.e fieldName: exist:table,column');
  let attArr = attribute.split(",");
  if (attArr.length !== 2) throw new Error(`Invalid format for validation rule on ${attribute}`);

  const { 0: table, 1: column } = attArr;
  let msg = (column == "username") ? `${column} has already been taken` : `${column} already in use`;

  Models[table].findOne({ [column]: value })
    .then((result) => {
      if (result) {
        passes(false, msg);
      } else {
        passes(true);
      }
    })
    .catch(() => passes(false, 'Database error'));
});

module.exports = validator;