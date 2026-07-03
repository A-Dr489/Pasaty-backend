export const isPhoneNumber = (input) => {
    // Allows digits, spaces, +, -, and ()
    const phoneRegex = /^[0-9+\-()\s]+$/;
    const digitCount = input.replace(/\D/g, '').length;
    
    // It's a phone number if it matches the allowed characters AND has at least 4 digits
    return phoneRegex.test(input) && digitCount >= 2;
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const httpError = (status, message) => new HttpError(status, message);