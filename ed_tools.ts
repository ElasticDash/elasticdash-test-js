// Sample tools for testing ElasticDash dashboard
export async function fetchUserData(userId) {
  // Simulates fetching user data from an API
  return { id: userId, name: 'John Doe', email: 'john@example.com' }
}

export function validateEmail(email) {
  // Email validation tool
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return re.test(email)
}

export async function sendNotification(userId, message) {
  // Simulates sending a notification
  return { sent: true, timestamp: Date.now() }
}

export function calculateDiscount(price, discountPercent) {
  // Calculates discounted price
  return price * (1 - discountPercent / 100)
}
