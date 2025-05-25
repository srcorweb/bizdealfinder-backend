const { pbkdf2, randomBytes } = require("crypto");
const { promisify } = require("util");

const pbkdf2Async = promisify(pbkdf2);

class HashMethod {
    static async hashPassword(password) {
        try {
            const salt = randomBytes(32).toString('hex'); // Generate a random salt
            const key = await pbkdf2Async(password, salt, 100000, 64, 'sha512');
            console.log("key-----", `${salt}:${key.toString('hex')}`);
            return `${salt}:${key.toString('hex')}`; // Combine salt and key
        } catch (error) {
            console.error("Error hashing password:", error);
            throw error;
        }
    }

    static async verifyPassword(hashedPassword, password) {
        try {
            const [salt, key] = hashedPassword.split(':'); // Extract salt and key
            const derivedKey = await pbkdf2Async(password, salt, 100000, 64, 'sha512');
            return key === derivedKey.toString('hex'); // Compare keys
        } catch (error) {
            console.error("Error verifying password:", error);
            return false; // Return false on error
        }
    }
}

module.exports = HashMethod;
