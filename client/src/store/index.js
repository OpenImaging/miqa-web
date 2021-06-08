import Promise from 'bluebird';
import Vue from 'vue';
import Vuex from 'vuex';
import vtkProxyManager from 'vtk.js/Sources/Proxy/Core/ProxyManager';
import { InterpolationType } from 'vtk.js/Sources/Rendering/Core/ImageProperty/Constants';
import _ from 'lodash';

import '../utils/registerReaders';

import readImageArrayBuffer from 'itk/readImageArrayBuffer';
import WorkerPool from 'itk/WorkerPool';
import ITKHelper from 'vtk.js/Sources/Common/DataModel/ITKHelper';
import ReaderFactory from '../utils/ReaderFactory';

import { proxy } from '../vtk';
import { getView } from '../vtk/viewManager';
import girder from '../girder';
import djangoRest from '../django';

const { convertItkToVtkImage } = ITKHelper;

Vue.use(Vuex);

const fileCache = new Map();
const datasetCache = new Map();
let readDataQueue = [];

const poolSize = navigator.hardwareConcurrency / 2 || 2;
let taskRunId = -1;
let savedWorker = null;
let sessionTimeoutId = null;

function shrinkProxyManager(proxyManager) {
  proxyManager.getViews().forEach((view) => {
    view.setContainer(null);
    proxyManager.deleteProxy(view);
  });
}

function prepareProxyManager(proxyManager) {
  if (!proxyManager.getViews().length) {
    ['View2D_Z:z', 'View2D_X:x', 'View2D_Y:y'].forEach((type) => {
      const view = getView(proxyManager, type);
      view.setOrientationAxesVisibility(false);
      view.getRepresentations().forEach((representation) => {
        representation.setInterpolationType(InterpolationType.NEAREST);
        representation.onModified(() => {
          view.render(true);
        });
      });
    });
  }
}

function getArrayName(filename) {
  const idx = filename.lastIndexOf('.');
  const name = idx > -1 ? filename.substring(0, idx) : filename;
  return `Scalars ${name}`;
}

function getData(id, file, webWorker = null) {
  return new Promise((resolve, reject) => {
    if (datasetCache.has(id)) {
      resolve({ imageData: datasetCache.get(id), webWorker });
    } else {
      const fileName = file.name;
      const io = new FileReader();

      io.onload = function onLoad() {
        readImageArrayBuffer(webWorker, io.result, fileName)
          .then(({ webWorker, image }) => { // eslint-disable-line no-shadow
            const imageData = convertItkToVtkImage(image, {
              scalarArrayName: getArrayName(fileName),
            });
            const dataRange = imageData
              .getPointData()
              .getArray(0)
              .getRange();
            datasetCache.set(id, { imageData });
            // eslint-disable-next-line no-use-before-define
            expandSessionRange(id, dataRange);
            resolve({ imageData, webWorker });
          })
          .catch((error) => {
            console.log('Problem reading image array buffer');
            console.log('webworker', webWorker);
            console.log('fileName', fileName);
            console.log(error);
            reject(error);
          });
      };

      io.readAsArrayBuffer(file);
    }
  });
}

function loadFile(imageId) {
  if (fileCache.has(imageId)) {
    return { imageId, fileP: fileCache.get(imageId) };
  }
  const p = ReaderFactory.downloadDataset(
    djangoRest.apiClient,
    'nifti.nii.gz',
    `/images/${imageId}/download`,
  );
  fileCache.set(imageId, p);
  return { imageId, fileP: p };
}

function loadFileAndGetData(imageId) {
  return loadFile(imageId).fileP.then((file) => getData(imageId, file, savedWorker)
    .then(({ webWorker, imageData }) => {
      savedWorker = webWorker;
      return Promise.resolve({ imageData });
    })
    .catch((error) => {
      const msg = 'loadFileAndGetData caught error getting data';
      console.log(msg);
      console.log(error);
      return Promise.reject(msg);
    })
    .finally(() => {
      if (savedWorker) {
        savedWorker.terminate();
        savedWorker = null;
      }
    }));
}

function poolFunction(webWorker, taskInfo) {
  return new Promise((resolve, reject) => {
    const { imageId } = taskInfo;

    let filePromise = null;

    if (fileCache.has(imageId)) {
      filePromise = fileCache.get(imageId);
    } else {
      filePromise = ReaderFactory.downloadDataset(
        djangoRest.apiClient,
        'nifti.nii.gz',
        `/images/${imageId}/download`,
      );
      fileCache.set(imageId, filePromise);
    }

    filePromise
      .then((file) => {
        resolve(getData(imageId, file, webWorker));
      })
      .catch((err) => {
        console.log('poolFunction: fileP error of some kind');
        console.log(err);
        reject(err);
      });
  });
}

const store = new Vuex.Store({
  state: {
    currentUser: null,
    drawer: false,
    experimentIds: [],
    experiments: {},
    experimentSessions: {},
    sessions: {},
    sessionDatasets: {},
    datasets: {},
    proxyManager: null,
    vtkViews: [],
    currentDatasetId: null,
    loadingDataset: false,
    errorLoadingDataset: false,
    loadingExperiment: false,
    currentScreenshot: null,
    screenshots: [],
    sites: null,
    sessionCachedPercentage: 0,
    responseInterceptor: null,
    userCheckPeriod: 60000, // In milliseconds
    sessionStatus: null,
    remainingSessionTime: 0,
    workerPool: new WorkerPool(poolSize, poolFunction),
  },
  getters: {
    sessionStatus(state) {
      return state.sessionStatus;
    },
    currentUser(state) {
      return state.currentUser;
    },
    currentDataset(state) {
      return state.currentDatasetId
        ? state.datasets[state.currentDatasetId]
        : null;
    },
    previousDataset(state, getters) {
      return getters.currentDataset
        ? getters.currentDataset.previousDataset
        : null;
    },
    nextDataset(state, getters) {
      return getters.currentDataset ? getters.currentDataset.nextDataset : null;
    },
    getDataset(state) {
      return (datasetId) => {
        if (!datasetId || !state.datasets[datasetId]) {
          return undefined;
        }
        return state.datasets[datasetId];
      };
    },
    currentSession(state, getters) {
      if (getters.currentDataset) {
        const curSessionId = getters.currentDataset.session;
        return state.sessions[curSessionId];
      }
      return null;
    },
    currentExperiment(state, getters) {
      if (getters.currentSession) {
        const curExperimentId = getters.currentSession.experiment;
        return state.experiments[curExperimentId];
      }
      return null;
    },
    experimentDatasets(state) {
      return (expId) => {
        const experimentSessions = state.experimentSessions[expId];
        const expDatasets = [];
        experimentSessions.forEach((sessionId) => {
          const sessionDatasets = state.sessionDatasets[sessionId];
          sessionDatasets.forEach((datasetId) => {
            expDatasets.push(datasetId);
          });
        });
        return expDatasets;
      };
    },
    getTodoById: (state) => (id) => state.todos.find((todo) => todo.id === id),
    firstDatasetInPreviousSession(state, getters) {
      return getters.currentDataset
        ? `${getters.currentDataset.firstDatasetInPreviousSession}`
        : null;
    },
    firstDatasetInNextSession(state, getters) {
      return getters.currentDataset
        ? getters.currentDataset.firstDatasetInNextSession
        : null;
    },
    firstDatasetInPreviousExeriment(state, getters) {
      if (getters.currentExperiment) {
        const expIdx = getters.currentExperiment.index;
        if (expIdx >= 1) {
          const prevExp = state.experiments[state.experimentIds[expIdx - 1]];
          const prevExpSessions = state.experimentSessions[prevExp.id];
          const prevExpSessionDatasets = state.sessionDatasets[prevExpSessions[0].id];
          return prevExpSessionDatasets[0];
        }
      }
      return null;
    },
    firstDatasetInNextExeriment(state, getters) {
      if (getters.currentExperiment) {
        const expIdx = getters.currentExperiment.index;
        if (expIdx < state.experimentIds.length - 1) {
          const nextExp = state.experiments[state.experimentIds[expIdx + 1]];
          const nextExpSessions = state.experimentSessions[nextExp.id];
          const nextExpSessionDatasets = state.sessionDatasets[nextExpSessions[0].id];
          return nextExpSessionDatasets[0];
        }
      }
      return null;
    },
    siteMap(state) {
      if (!state.sites) {
        return {};
      }
      return _.keyBy(state.sites, 'id');
    },
    getSiteDisplayName(state, getters) {
      return (id) => {
        const { siteMap } = getters;
        if (siteMap[id]) {
          return siteMap[id].name;
        }
        return id;
      };
    },
    getExperimentDisplayName(state) {
      return (id) => {
        if (state.experiments[id]) {
          return state.experiments[id].name;
        }
        return id;
      };
    },
    remainingSessionTime(state) {
      return state.remainingSessionTime;
    },
  },
  mutations: {
    setCurrentImageId(state, imageId) {
      state.currentDatasetId = imageId;
    },
    setScan(state, { scanId, scan }) {
      // Replace with a new object to trigger a Vuex update
      state.sessions = { ...state.sessions };
      state.sessions[scanId] = scan;
    },
    setSessionStatus(state, status) {
      state.sessionStatus = status;
    },
    setCurrentUser(state, user) {
      state.currentUser = user;
    },
    setDrawer(state, value) {
      state.drawer = value;
    },
    setCurrentScreenshot(state, screenshot) {
      state.currentScreenshot = screenshot;
    },
    addScreenshot(state, screenshot) {
      state.screenshots.push(screenshot);
    },
    removeScreenshot(state, screenshot) {
      state.screenshots.splice(state.screenshots.indexOf(screenshot), 1);
    },
    setResponseInterceptor(state, interceptor) {
      state.responseInterceptor = interceptor;
    },
    setRemainingSessionTime(state, timeRemaining) {
      state.remainingSessionTime = timeRemaining;
    },
  },
  actions: {
    reset({ state, commit }) {
      if (sessionTimeoutId !== null) {
        window.clearTimeout(sessionTimeoutId);
        sessionTimeoutId = null;
      }

      if (state.responseInterceptor !== null) {
        girder.rest.interceptors.response.eject(state.responseInterceptor);
        state.responseInterceptor = null;
      }

      if (taskRunId >= 0) {
        state.workerPool.cancel(taskRunId);
        taskRunId = -1;
      }

      // TODO replace this with a reset mutation
      state.currentUser = null;
      state.drawer = false;
      state.experimentIds = [];
      state.experiments = {};
      state.experimentSessions = {};
      state.sessions = {};
      state.sessionDatasets = {};
      state.datasets = {};
      state.proxyManager = null;
      state.vtkViews = [];
      commit('setCurrentImageId', null);
      state.loadingDataset = false;
      state.errorLoadingDataset = false;
      state.loadingExperiment = false;
      state.currentScreenshot = null;
      state.screenshots = [];
      state.sites = null;
      state.sessionCachedPercentage = 0;
      state.sessionStatus = null;
      state.remainingSessionTime = 0;

      fileCache.clear();
      datasetCache.clear();
    },
    logout({ commit, dispatch }) {
      dispatch('reset');
      girder.rest.logout();
      commit('setSessionStatus', 'logout');
    },
    async requestCurrentUser({ commit }) {
      const remainingTime = await girder.rest.get('miqa/sessiontime');
      commit('setRemainingSessionTime', remainingTime.data);
    },
    startLoginMonitor() {
      // startLoginMonitor({ state, commit, dispatch }) {
      // TODO figure this out
      // if (state.responseInterceptor === null) {
      //   state.responseInterceptor = girder.rest.interceptors.response.use(
      //     response => response,
      //     error => {
      //       if (state.currentUser !== null && error.response.status === 401) {
      //         commit("setSessionStatus", "timeout");
      //       } else {
      //         return Promise.reject(error);
      //       }
      //     }
      //   );
      //
      //   const checkUser = () => {
      //     dispatch("requestCurrentUser");
      //     sessionTimeoutId = window.setTimeout(
      //       checkUser,
      //       state.userCheckPeriod
      //     );
      //   };
      //
      //   checkUser();
      // }
    },
    async loadSessions({ state }) {
      // let { data: sessionTree } = await girder.rest.get(`miqa/sessions`);
      //
      // state.experimentIds = [];
      // state.experiments = {};
      // state.experimentSessions = {};
      // state.sessions = {};
      // state.sessionDatasets = {};
      // state.datasets = {};
      //
      // // Build navigation links throughout the dataset to improve performance.
      // let firstInPrev = null;
      //
      // for (let i = 0; i < sessionTree.length; i++) {
      //   let experiment = sessionTree[i];
      //   let experimentId = experiment.folderId;
      //
      //   state.experimentIds.push(experimentId);
      //   state.experiments[experimentId] = {
      //     id: experimentId,
      //     folderId: experimentId,
      //     name: experiment.name,
      //     index: i
      //   };
      //
      //   let sessions = experiment.sessions.sort(
      //     (a, b) => a.meta.scanId - b.meta.scanId
      //   );
      //
      //   state.experimentSessions[experimentId] = [];
      //
      //   for (let j = 0; j < sessions.length; j++) {
      //     let session = sessions[j];
      //     let sessionId = session.folderId;
      //
      //     state.experimentSessions[experimentId].push(sessionId);
      //     state.sessions[sessionId] = {
      //       id: sessionId,
      //       folderId: sessionId,
      //       name: session.name,
      //       meta: Object.assign({}, session.meta),
      //       numDatasets: session.datasets.length,
      //       cumulativeRange: [Number.MAX_VALUE, -Number.MAX_VALUE], // [null, null],
      //       experiment: experimentId
      //     };
      //
      //     state.sessionDatasets[sessionId] = [];
      //
      //     for (let k = 0; k < session.datasets.length; k++) {
      //       let dataset = session.datasets[k];
      //       let datasetId = dataset._id;
      //
      //       state.sessionDatasets[sessionId].push(datasetId);
      //       state.datasets[datasetId] = Object.assign({}, dataset);
      //       state.datasets[datasetId].session = sessionId;
      //       state.datasets[datasetId].index = k;
      //       state.datasets[datasetId].previousDataset =
      //         k > 0 ? session.datasets[k - 1]._id : null;
      //       state.datasets[datasetId].nextDataset =
      //         k < session.datasets.length - 1
      //           ? session.datasets[k + 1]._id
      //           : null;
      //       state.datasets[
      //         datasetId
      //       ].firstDatasetInPreviousSession = firstInPrev;
      //     }
      //     if (session.datasets.length > 0) {
      //       firstInPrev = session.datasets[0]._id;
      //     } else {
      //       console.error(`${experiment.name}/${session.name} has no datasets`);
      //     }
      //   }
      // }
      //
      // // Now iterate through the session tree backwards to build up the links
      // // to the "firstInNext" datasets.
      // let firstInNext = null;
      //
      // for (let i = sessionTree.length - 1; i >= 0; i--) {
      //   let experiment = sessionTree[i];
      //   for (let j = experiment.sessions.length - 1; j >= 0; j--) {
      //     let session = experiment.sessions[j];
      //     for (let k = session.datasets.length - 1; k >= 0; k--) {
      //       let datasetId = session.datasets[k]._id;
      //       let dataset = state.datasets[datasetId];
      //       dataset.firstDatasetInNextSession = firstInNext;
      //     }
      //     if (session.datasets.length > 0) {
      //       firstInNext = session.datasets[0]._id;
      //     } else {
      //       console.error(
      //         `${experiment.name}/${session.name}) has no datasets`
      //       );
      //     }
      //   }
      // }
      state.experimentIds = [];
      state.experiments = {};
      state.experimentSessions = {};
      state.sessions = {};
      state.sessionDatasets = {};
      state.datasets = {};

      // Build navigation links throughout the dataset to improve performance.
      let firstInPrev = null;

      const sessions = await djangoRest.sessions();
      // Just use the first session for now
      const session = sessions[0];

      const experiments = await djangoRest.experiments(session.id);
      for (let i = 0; i < experiments.length; i += 1) {
        const experiment = experiments[i];
        // set experimentSessions[experiment.id] before registering the experiment.id
        // so SessionsView doesn't update prematurely
        state.experimentSessions[experiment.id] = [];
        state.experimentIds.push(experiment.id);
        state.experiments[experiment.id] = {
          id: experiment.id,
          name: experiment.name,
          index: i,
        };

        // Web sessions == Django scans
        // TODO these requests *can* be run in parallel, or collapsed into one XHR
        // eslint-disable-next-line no-await-in-loop
        const scans = await djangoRest.scans(experiment.id);
        for (let j = 0; j < scans.length; j += 1) {
          const scan = scans[j];
          state.sessionDatasets[scan.id] = [];
          state.experimentSessions[experiment.id].push(scan.id);

          // Web datasets == Django images
          // TODO these requests *can* be run in parallel, or collapsed into one XHR
          // eslint-disable-next-line no-await-in-loop
          const images = await djangoRest.images(scan.id);

          state.sessions[scan.id] = {
            id: scan.id,
            name: scan.scan_type,
            experiment: experiment.id,
            cumulativeRange: [Number.MAX_VALUE, -Number.MAX_VALUE],
            numDatasets: images.length,
            site: scan.site,
            notes: scan.notes,
            decisions: scan.decisions,
            // folderId: sessionId,
            // meta: Object.assign({}, session.meta),
          };

          for (let k = 0; k < images.length; k += 1) {
            const image = images[k];
            state.sessionDatasets[scan.id].push(image.id);
            state.datasets[image.id] = { ...image };
            state.datasets[image.id].session = scan.id;
            state.datasets[image.id].experiment = experiment.id;
            state.datasets[image.id].index = k;
            state.datasets[image.id].previousDataset = k > 0 ? images[k - 1].id : null;
            state.datasets[image.id].nextDataset = k < images.length - 1 ? images[k + 1].id : null;
            state.datasets[
              image.id
            ].firstDatasetInPreviousSession = firstInPrev;
          }
          if (images.length > 0) {
            firstInPrev = images[0].id;
          } else {
            console.error(
              `${experiment.name}/${scan.scan_type} has no datasets`,
            );
          }
        }
      }
    },
    // This would be called reloadSession, but session is being renamed to scan
    async reloadScan({ commit, getters }) {
      const currentImage = getters.currentDataset;
      if (!currentImage) {
        return;
      }
      const scanId = currentImage.session;
      if (!scanId) {
        return;
      }
      const scan = await djangoRest.scan(scanId);
      const images = await djangoRest.images(scanId);
      commit('setScan', {
        scanId: scan.id,
        scan: {
          id: scan.id,
          name: scan.scan_type,
          experiment: scan.experiment,
          cumulativeRange: [Number.MAX_VALUE, -Number.MAX_VALUE],
          numDatasets: images.length,
          site: scan.site,
          notes: scan.notes,
          decisions: scan.decisions,
        },
      });
    },
    async setCurrentImage({ commit, dispatch }, imageId) {
      commit('setCurrentImageId', imageId);
      if (imageId) {
        dispatch('reloadScan');
      }
    },
    async swapToDataset({ state, dispatch, getters }, dataset) {
      if (!dataset) {
        throw new Error("dataset id doesn't exist");
      }
      if (getters.currentDataset === dataset) {
        return;
      }
      state.loadingDataset = true;
      state.errorLoadingDataset = false;
      const oldSession = getters.currentSession;
      const newSession = state.sessions[dataset.session];
      const oldExperiment = getters.currentExperiment
        ? getters.currentExperiment
        : null;
      const newExperimentId = state.sessions[dataset.session].experiment;
      const newExperiment = state.experiments[newExperimentId];

      // Check if we should cancel the currently loading experiment
      if (
        newExperiment
        && oldExperiment
        && newExperiment.folderId !== oldExperiment.folderId
        && taskRunId >= 0
      ) {
        state.workerPool.cancel(taskRunId);
        taskRunId = -1;
      }

      let newProxyManager = false;
      if (oldSession !== newSession && state.proxyManager) {
        // If we don't "shrinkProxyManager()" and reinitialize it between
        // "sessions" (a.k.a "scans"), then we can end up with no image
        // slices displayed, even though we have the data and attempted
        // to render it.  This may be due to image extents changing between
        // scans, which is not the case from one timestep of a single scan
        // to tne next.
        shrinkProxyManager(state.proxyManager);
        newProxyManager = true;
      }

      if (!state.proxyManager || newProxyManager) {
        state.proxyManager = vtkProxyManager.newInstance({
          proxyConfiguration: proxy,
        });
        state.vtkViews = [];
      }

      let sourceProxy = state.proxyManager.getActiveSource();
      let needPrep = false;
      if (!sourceProxy) {
        sourceProxy = state.proxyManager.createProxy(
          'Sources',
          'TrivialProducer',
        );
        needPrep = true;
      }

      // This try catch and within logic are mainly for handling data doesn't exist issue
      try {
        let imageData = null;
        if (datasetCache.has(dataset.id)) {
          imageData = datasetCache.get(dataset.id).imageData;
        } else {
          const result = await loadFileAndGetData(dataset.id);
          imageData = result.imageData;
        }
        sourceProxy.setInputData(imageData);
        if (needPrep || !state.proxyManager.getViews().length) {
          prepareProxyManager(state.proxyManager);
          state.vtkViews = state.proxyManager.getViews();
        }
        if (!state.vtkViews.length) {
          state.vtkViews = state.proxyManager.getViews();
        }
      } catch (err) {
        console.log('Caught exception loading next image');
        console.log(err);
        state.vtkViews = [];
        state.errorLoadingDataset = true;
      } finally {
        dispatch('setCurrentImage', dataset.id);
        state.loadingDataset = false;
      }

      // If necessary, queue loading scans of new experiment
      // eslint-disable-next-line no-use-before-define
      checkLoadExperiment(oldExperiment, newExperiment);
    },
    async loadSites({ state }) {
      const sites = await djangoRest.sites();
      // let { data: sites } = await girder.rest.get("miqa_setting/site");
      state.sites = sites;
    },
  },
});

// cache datasets associated with sessions of current experiment
function checkLoadExperiment(oldValue, newValue) {
  if (
    !newValue
    || newValue === oldValue
    || (newValue && oldValue && newValue.folderId === oldValue.folderId)
  ) {
    return;
  }

  if (oldValue) {
    const oldExperimentSessions = store.state.experimentSessions[oldValue.id];
    oldExperimentSessions.forEach((sessionId) => {
      const sessionDatasets = store.state.sessionDatasets[sessionId];
      sessionDatasets.forEach((datasetId) => {
        fileCache.delete(datasetId);
        datasetCache.delete(datasetId);
      });
    });
  }

  readDataQueue = [];
  const newExperimentSessions = store.state.experimentSessions[newValue.id];
  newExperimentSessions.forEach((sessionId) => {
    const sessionDatasets = store.state.sessionDatasets[sessionId];
    sessionDatasets.forEach((datasetId) => {
      readDataQueue.push({
        // TODO don't hardcode sessionId
        sessionId: 1,
        experimentId: newValue.id,
        scanId: sessionId,
        imageId: datasetId,
      });
    });
  });
  startReaderWorkerPool(); // eslint-disable-line no-use-before-define
}

function progressHandler(completed, total) {
  const percentComplete = completed / total;
  store.state.sessionCachedPercentage = percentComplete;
}

function startReaderWorkerPool() {
  const taskArgsArray = [];

  store.state.loadingExperiment = true;

  readDataQueue.forEach((taskInfo) => {
    taskArgsArray.push([taskInfo]);
  });

  readDataQueue = [];

  const { runId, promise } = store.state.workerPool.runTasks(
    taskArgsArray,
    progressHandler,
  );
  taskRunId = runId;

  promise
    .then((results) => {
      console.log(`WorkerPool finished with ${results.length} results`);
      taskRunId = -1;
    })
    .catch((err) => {
      console.log('startReaderWorkerPool: workerPool error');
      console.log(err);
    })
    .finally(() => {
      store.state.loadingExperiment = false;
      store.state.workerPool.terminateWorkers();
    });
}

function expandSessionRange(datasetId, dataRange) {
  if (datasetId in store.state.datasets) {
    const sessionId = store.state.datasets[datasetId].session;
    const session = store.state.sessions[sessionId];
    if (dataRange[0] < session.cumulativeRange[0]) {
      [session.cumulativeRange[0]] = dataRange;
    }
    if (dataRange[1] > session.cumulativeRange[1]) {
      [, session.cumulativeRange[1]] = dataRange;
    }
  }
}

export default store;
