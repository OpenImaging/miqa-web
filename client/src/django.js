import axios from 'axios';
import Vue from 'vue';
import OAuthClient from '@girder/oauth-client';
import { API_URL, OAUTH_API_ROOT, OAUTH_CLIENT_ID } from './constants';

const apiClient = axios.create({ baseURL: API_URL });
const oauthClient = new OAuthClient(OAUTH_API_ROOT, OAUTH_CLIENT_ID);
const djangoClient = new Vue({
  data: () => ({
    user: null,
    store: null,
    apiClient,
  }),
  methods: {
    setStore(store) {
      this.store = store;
    },
    async resetActionTimer() {
      await oauthClient.maybeRestoreLogin();
      this.store.dispatch('resetActionTimer');
    },
    async restoreLogin() {
      await oauthClient.maybeRestoreLogin();
      if (oauthClient.isLoggedIn) {
        Object.assign(
          apiClient.defaults.headers.common,
          oauthClient.authHeaders,
        );

        this.user = await this.me();
      }
    },
    async login() {
      await oauthClient.redirectToLogin();
    },
    async logout() {
      await oauthClient.logout();
      this.user = null;
    },
    async import(sessionId) {
      await this.resetActionTimer();
      await apiClient.post(`/sessions/${sessionId}/import`);
    },
    async sessions() {
      await this.resetActionTimer();
      const { data } = await apiClient.get('/sessions');
      const { results } = data;
      return results;
    },
    async sites() {
      await this.resetActionTimer();
      const { data } = await apiClient.get('/sites');
      const { results } = data;
      return results;
    },
    async experiments(sessionId) {
      await this.resetActionTimer();
      const { data } = await apiClient.get('/experiments', {
        params: { session: sessionId },
      });
      const { results } = data;
      return results;
    },
    async scans(experimentId) {
      await this.resetActionTimer();
      const { data } = await apiClient.get('/scans', {
        params: { experiment: experimentId },
      });
      const { results } = data;
      return results;
    },
    async scan(scanId) {
      await this.resetActionTimer();
      const { data } = await apiClient.get(`/scans/${scanId}`);
      return data;
    },
    async setDecision(scanId, decision) {
      await this.resetActionTimer();
      await apiClient.post(`/scans/${scanId}/decision`, { decision });
    },
    async addScanNote(scanId, note) {
      await this.resetActionTimer();
      await apiClient.post('/scan_notes', {
        scan: scanId,
        note,
      });
    },
    async setScanNote(scanNoteId, note) {
      await this.resetActionTimer();
      await apiClient.put(`/scan_notes/${scanNoteId}`, { note });
    },
    async images(scanId) {
      await this.resetActionTimer();
      const { data } = await apiClient.get('/images', {
        params: { scan: scanId },
      });
      const { results } = data;
      return results;
    },
    async me() {
      const resp = await apiClient.get('/users/me');
      return resp.status === 204 ? null : resp.data;
    },
  },
});

export default djangoClient;
