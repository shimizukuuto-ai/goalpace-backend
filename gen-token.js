require('dotenv').config()
const auth = require('./auth.js');
console.log(auth.issueSessionToken('dev-user'));
