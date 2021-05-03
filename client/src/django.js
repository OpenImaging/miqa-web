import axios from "axios";
import Vue from "vue";
import OAuthClient from "@girder/oauth-client";
import { API_URL, OAUTH_API_ROOT, OAUTH_CLIENT_ID } from "./constants";

const apiClient = axios.create({ baseURL: API_URL });
const oauthClient = new OAuthClient(OAUTH_API_ROOT, OAUTH_CLIENT_ID);
const djangoClient = new Vue({
  data: () => {
    return {
      user: null,
      apiClient
    };
  },
  methods: {
    async restoreLogin() {
      await oauthClient.maybeRestoreLogin();
      if (oauthClient.isLoggedIn) {
        this.user = await this.me();
      } else {
        this.login();
      }
    },
    async login() {
      await oauthClient.redirectToLogin();
    },
    async logout() {
      await oauthClient.logout();
      this.user = null;
    },
    async sessions() {
      const { data } = await apiClient.get("/sessions");
      const { results } = data;
      return results;
    },
    async experiments(sessionId) {
      const { data } = await apiClient.get("/experiments", {
        params: { session: sessionId }
      });
      const { results } = data;
      return results;
    },
    async scans(experimentId) {
      const { data } = await apiClient.get("/scans", {
        params: { experiment: experimentId }
      });
      const { results } = data;
      return results;
    },
    async scan(scanId) {
      const { data } = await apiClient.get(`/scans/${scanId}`);
      return data;
    },
    async images(scanId) {
      const { data } = await apiClient.get("/images", {
        params: { scan: scanId }
      });
      const { results } = data;
      return results;
    },
    async me() {
      return {};
    }
  }
});

export default djangoClient;
