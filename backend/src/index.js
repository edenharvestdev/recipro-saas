// จุดเริ่มเซิร์ฟเวอร์ (Railway: npm start)
require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Recipro API + frontend on :${PORT}`));
