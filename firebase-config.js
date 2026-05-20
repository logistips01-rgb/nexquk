// ============================================================
// NEXQUK — Configuración Firebase
// ============================================================
// 1. Ve a https://console.firebase.google.com
// 2. Crea un proyecto (o usa uno existente)
// 3. Proyecto > Configuración > Tu aplicación web > Añadir app web
// 4. Copia los valores aquí
// 5. En Firebase Console activa:
//    - Authentication > Google
//    - Realtime Database (región europe-west1)
//    - En Reglas RTDB pega las de README.md
// ============================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getDatabase } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const firebaseConfig = {
  apiKey:            "TU_API_KEY",
  authDomain:        "TU_PROYECTO.firebaseapp.com",
  databaseURL:       "https://TU_PROYECTO-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "TU_PROYECTO_ID",
  storageBucket:     "TU_PROYECTO.firebasestorage.app",
  messagingSenderId: "TU_SENDER_ID",
  appId:             "TU_APP_ID"
};

export const firebaseApp = initializeApp(firebaseConfig);
export const db          = getDatabase(firebaseApp);
export const auth        = getAuth(firebaseApp);
