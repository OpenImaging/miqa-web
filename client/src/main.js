import Vue from 'vue';
import Vuetify from 'vuetify';

import AsyncComputed from 'vue-async-computed';
import Girder, { vuetifyConfig } from '@girder/components/src';
import config from 'itk/itkConfig';
import App from './App.vue';
import router from './router';
import store from './store';
import { STATIC_PATH } from './constants';

import vMousetrap from './vue-utilities/v-mousetrap';
import snackbarService from './vue-utilities/snackbar-service';
import promptService from './vue-utilities/prompt-service';
import girder from './girder';

import 'vuetify/dist/vuetify.min.css';

import './vtk/ColorMaps';

import djangoRest from './django';

Vue.use(Vuetify);

// import proxyConfigGenerator from './store/proxyConfigGenerator';

Vue.use(AsyncComputed);
Vue.use(Girder);
Vue.use(vMousetrap);

// Merge our own (currently empty) configuration with the one provided by
// Girder web components (needed for the login dialog to render properly).
const vuetifyOptions = { ...vuetifyConfig };
const vuetify = new Vuetify(vuetifyOptions);

Vue.use(snackbarService(vuetify));
Vue.use(promptService(vuetify));

girder.rest = { user: null };
config.itkModulesPath = STATIC_PATH + config.itkModulesPath;

// console.log(store);
window.store = store;

Vue.config.productionTip = true;

// Disable console log on production
if (process.env.NODE_ENV === 'production') {
  // eslint-disable-next-line no-console
  console.log = () => { };
}

djangoRest.restoreLogin().then((user) => {
  new Vue({
    vuetify,
    router,
    store,
    render: (h) => h(App),
    provide: { girderRest: girder.rest, djangoRest },
  })
    .$mount('#app')
    .$snackbarAttach()
    .$promptAttach();

  if (user) {
    store.commit('setCurrentUser', user);
    store.commit('setSessionStatus', 'active');
  } else {
    store.commit('setSessionStatus', 'init');
  }

  store.dispatch('startLoginMonitor');
});
