'use strict';

const axios = require('axios');

/**
 * Obtiene un token OAuth desde la API de AWS
 * @returns {Promise<string>} Token OAuth
 */
async function getToken(params) {
  const url = params.url;

  const headers = {
    'Content-Type': 'application/json'
  };

  const body = JSON.stringify({
    username: params.user,
    password: params.password
  });

  try {
    const response = await axios({
      method: 'post',
      url: url,
      headers: headers,
      data: body
    });

    const token = response.data?.token;

    if (!token) {
      throw new Error('Token not found in response');
    }

    return token;
  } catch (error) {
    console.error('❌ Error getting token:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    throw error;
  }
}
// Exportar las funciones
module.exports = {
  getToken
};
