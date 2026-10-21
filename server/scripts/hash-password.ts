// Prints the bcrypt hash for ADMIN_PASSWORD_HASH: npm run hash-password -- 'your password'
import bcrypt from 'bcryptjs';

const password = process.argv[2];
if (!password) {
  console.error("Usage: npm run hash-password -- 'your password'");
  process.exit(1);
}
console.log(bcrypt.hashSync(password, 12));
