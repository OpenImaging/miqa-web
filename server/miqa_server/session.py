import datetime
import io
import json
from jsonschema import validate
from jsonschema.exceptions import ValidationError as JSONValidationError
import os

from girder.api.rest import Resource, setResponseHeader, setContentDisposition
from girder.api import access, rest
from girder.constants import AccessType
from girder.exceptions import RestException
from girder.api.describe import Description, autoDescribeRoute
from girder.models.collection import Collection
from girder.models.assetstore import Assetstore
from girder.models.folder import Folder
from girder.models.item import Item
from girder.models.setting import Setting
from girder.utility.progress import noProgress

from .setting import fileWritable, tryAddSites
from .constants import exportpathKey, importpathKey
from .schema.data_import import schema


class Session(Resource):
    def __init__(self):
        super(Session, self).__init__()
        self.resourceName = 'miqa'

        self.route('POST', ('data', 'import',), self.dataImport)
        self.route('GET', ('sessions',), self.getSessions)
        self.route('GET', ('data', 'export',), self.dataExport)
        self.route('GET', ('data', 'export', 'download',), self.dataExportDownload)

    @access.user
    @autoDescribeRoute(
        Description('Retrieve all sessions in a tree structure')
        .errorResponse())
    def getSessions(self, params):
        return self._getSessions()

    def _getSessions(self):
        user = self.getCurrentUser()
        sessionsFolder = self.findSessionsFolder()
        if not sessionsFolder:
            return []
        experiments = []
        for experimentFolder in Folder().childFolders(sessionsFolder, 'folder', user=user):
            sessions = []
            experiments.append({
                'folderId': experimentFolder['_id'],
                'name': experimentFolder['name'],
                'sessions': sessions
            })
            for sessionFolder in Folder().childFolders(experimentFolder, 'folder', user=user):
                datasets = list(Item().find({'$query': {'folderId': sessionFolder['_id'],
                                                        'name': {'$regex': 'nii.gz$'}}, '$orderby': {'name': 1}}))
                sessions.append({
                    'folderId': sessionFolder['_id'],
                    'name': sessionFolder['name'],
                    'meta': sessionFolder.get('meta', {}),
                    'datasets': datasets
                })
        return experiments

    @access.user
    @autoDescribeRoute(
        Description('')
        .errorResponse())
    def dataImport(self, params):
        user = self.getCurrentUser()
        importpath = os.path.expanduser(Setting().get(importpathKey))
        if not os.path.isfile(importpath):
            raise RestException('import csv file doesn\'t exists', code=404)
        with open(importpath) as json_file:
            json_content = json.load(json_file)
            try:
                validate(json_content, schema)
            except JSONValidationError as inst:
                return {
                    "error": 'Invalid JSON file: '.format(inst.message),
                    "success": successCount,
                    "failed": failedCount
                }
            existingSessionsFolder = self.findSessionsFolder(user)
            if existingSessionsFolder:
                existingSessionsFolder['name'] = 'sessions_' + \
                    datetime.datetime.now().strftime("%Y-%m-%d %I:%M:%S %p")
                Folder().save(existingSessionsFolder)
            sessionsFolder = self.findSessionsFolder(user, True)
            Item().createItem('json', user, sessionsFolder, description=json_content)

            datasetRoot = json_content['data_root']
            experiments = json_content['experiments']
            sites = json_content['sites']

            successCount = 0
            failedCount = 0
            sites = set()
            for scan in json_content['scans']:
                experimentId = scan['experiment_id']
                experimentNote = ''
                for experiment in experiments:
                    if experiment['id'] == experimentId:
                        experimentNote = experiment['note']
                scanPath = scan['path']
                site = scan['site_id']
                sites.add(site)
                scanId = scan['id']
                scanType = scan['type']
                scan = scanId+'_'+scanType
                niftiFolder = os.path.expanduser(os.path.join(datasetRoot, scanPath))
                if not os.path.isdir(niftiFolder):
                    failedCount += 1
                    continue
                experimentFolder = Folder().createFolder(
                    sessionsFolder, experimentId, parentType='folder', reuseExisting=True)
                scanFolder = Folder().createFolder(
                    experimentFolder, scan, parentType='folder', reuseExisting=True)
                meta = {
                    'experimentId': experimentId,
                    'experimentNote': experimentNote,
                    'site': site,
                    'scanId': scanId,
                    'scanType': scanType
                }
                # Merge note and rating if record exists
                if existingSessionsFolder:
                    existingMeta = self.tryGetExistingSessionMeta(
                        existingSessionsFolder, experimentId, scan)
                    if(existingMeta and (existingMeta.get('note', None) or existingMeta.get('rating', None))):
                        meta['note'] = existingMeta.get('note', None)
                        meta['rating'] = existingMeta.get('rating', None)
                Folder().setMetadata(scanFolder, meta)
                currentAssetstore = Assetstore().getCurrent()
                scanImages = scan['images']
                for scanImage in scanImages:
                    absImagePath = os.path.join(niftiFolder, scanImage)
                    imageItem = Item().createItem(name=scanImage, creator=user, folder=scanFolder, reuseExisting=True)
                    Assetstore().importFile(imageItem, absImagePath, user, name=scanImage)
                # Assetstore().importData(
                #     currentAssetstore, parent=scanFolder, parentType='folder', params={
                #         'fileIncludeRegex': '.+[.]nii[.]gz$',
                #         'importPath': niftiFolder,
                #     }, progress=noProgress, user=user, leafFoldersAsItems=False)
                successCount += 1
            tryAddSites(sites, self.getCurrentUser())
            return {
                "success": successCount,
                "failed": failedCount
            }

    @access.user
    @autoDescribeRoute(
        Description('')
        .errorResponse())
    def dataExport(self, params):
        exportpath = os.path.expanduser(Setting().get(exportpathKey))
        if not fileWritable(exportpath):
            raise RestException('export json file is not writable', code=500)
        output = self.getExportJSON()
        with open(exportpath, 'w') as json_file:
            json_file.write(output.getvalue())

    @access.admin(cookie=True)
    @autoDescribeRoute(
        Description('')
        .errorResponse())
    def dataExportDownload(self, params):
        setResponseHeader('Content-Type', 'application/json')
        setContentDisposition('_output.json')
        output = self.getExportJSON()
        return lambda: [(yield x) for x in output.getvalue()]

    def getExportJSON(self):
        def convertRatingToDecision(rating):
            return {
                None: 0,
                'questionable': 0,
                'good': 1,
                'usableExtra': 2,
                'bad': -1
            }[rating]
        sessionsFolder = self.findSessionsFolder()
        items = list(Folder().childItems(sessionsFolder, filters={'name': 'json'}))
        if not len(items):
            raise RestException('doesn\'t contain a json item', code=404)
        csvItem = items[0]
        # Next TODO: read, format, and stream back the json version of the export
        reader = csv.DictReader(io.StringIO(csvItem['description']))
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=reader.fieldnames)
        writer.writeheader()
        for row in reader:
            experience = Folder().findOne({
                'name': row['xnat_experiment_id'],
                'parentId': sessionsFolder['_id']
            })
            if not experience:
                continue
            session = Folder().findOne({
                'name': row['scan_id']+'_'+row['scan_type'],
                'parentId': experience['_id']
            })
            if not session:
                continue
            row['decision'] = convertRatingToDecision(session.get('meta', {}).get('rating', None))
            row['scan_note'] = session.get('meta', {}).get('note', None)
            writer.writerow(row)
        return output

    def findSessionsFolder(self, user=None, create=False):
        collection = Collection().findOne({'name': 'miqa'})
        sessionsFolder = Folder().findOne({'name': 'sessions', 'baseParentId': collection['_id']})
        if not create:
            return sessionsFolder
        else:
            if not sessionsFolder:
                return Folder().createFolder(collection, 'sessions',
                                             parentType='collection', creator=user)

    def tryGetExistingSessionMeta(self, sessionsFolder, experimentId, scan):
        experimentFolder = Folder().findOne(
            {'name': experimentId, 'parentId': sessionsFolder['_id']})
        if not experimentFolder:
            return None
        sessionFolder = Folder().findOne(
            {'name': scan, 'parentId': experimentFolder['_id']})
        if not sessionFolder:
            return None
        return sessionFolder.get('meta', {})
