// firebase.js

// ===== Import các SDK cần thiết =====
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-analytics.js";
import { 
  getAuth, 
  GoogleAuthProvider, 
  signInWithPopup, 
  onAuthStateChanged, 
  signOut 
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";
// Nếu bạn muốn dùng Firestore/Storage, import thêm:
// import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";
// import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-storage.js";

// ===== Cấu hình Firebase (bạn lấy từ console) =====
const firebaseConfig = {
  apiKey: "AIzaSyBkCyKuDLdNjNhB_vIE4IYO6VtWRQ8wC14",
  authDomain: "miraa-8b1d8.firebaseapp.com",
  projectId: "miraa-8b1d8",
  storageBucket: "miraa-8b1d8.firebasestorage.app",
  messagingSenderId: "954725414931",
  appId: "1:954725414931:web:37054c7204e75ac46a27e6",
  measurementId: "G-ECEZYQZJ7X"
};

// ===== Khởi tạo =====
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

// ===== Auth với Google =====
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

// Xuất ra để app.js dùng
export {
  app, analytics,
  auth, provider,
  signInWithPopup, onAuthStateChanged, signOut
};
