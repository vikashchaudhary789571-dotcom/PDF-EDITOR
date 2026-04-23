import axios from 'axios';

const api = axios.create({
    baseURL: 'https://statsedit-api.onrender.com/api',
    headers: {
        'Content-Type': 'application/json',
    },
});

// Add a request interceptor to include the JWT token in all requests
api.interceptors.request.use(
    (config) => {
        const authData = localStorage.getItem('fin_auth_data');
        if (authData) {
            const { token } = JSON.parse(authData);
            if (token) {
                config.headers.Authorization = `Bearer ${token}`;
            }
        }
        return config;
    },
    (error) => Promise.reject(error)
);

export const authService = {
    login: async (email, password) => {
        const response = await api.post('/auth/login', { email, password });
        return response.data;
    },
    register: async (name, email, password) => {
        const response = await api.post('/auth/register', { name, email, password });
        return response.data;
    },
};

export const statementService = {
    upload: async (file, password) => {
        const formData = new FormData();
        formData.append('file', file);
        if (password) {
            formData.append('password', password);
            console.log('[API] Sending password:', password);
        } else {
            console.log('[API] No password provided');
        }
        console.log('[API] FormData entries:');
        for (let pair of formData.entries()) {
            console.log(pair[0] + ': ' + pair[1]);
        }
        const response = await api.post('/statements/upload', formData, {
            headers: {
                'Content-Type': 'multipart/form-data',
            },
        });
        return response.data;
    },
    save: async (transactions, filename) => {
        const response = await api.post('/statements/save', { transactions, filename });
        return response.data;
    },
    saveFile: async (fileUrl, originalName, size) => {
        const response = await api.post('/statements/save-file', { fileUrl, originalName, size });
        return response.data;
    },
    deleteFile: async (id) => {
        const response = await api.delete(`/statements/${id}`);
        return response.data;
    },
    getAll: async () => {
        const response = await api.get('/statements');
        return response.data;
    },
    regenerate: async (transactions, originalFile) => {
        const response = await api.post('/statements/regenerate', { transactions, originalFile });
        return response.data;
    },
};

export default api;
