import type {
  InstanceFileContentDto,
  InstanceFileDeleteResult,
  InstanceFileEntry,
  InstanceFileListDto,
  InstanceFileRenameResult,
  InstanceFileUploadResult,
  InstanceFileWriteResult,
  InstanceKeyFile,
  InstanceKeyFileListDto,
} from '../../../shared/contracts/instance-file'
import api from '../index'

export type {
  InstanceFileContentDto,
  InstanceFileDeleteResult,
  InstanceFileEntry,
  InstanceFileListDto,
  InstanceFileRenameResult,
  InstanceFileUploadResult,
  InstanceFileWriteResult,
  InstanceKeyFile,
  InstanceKeyFileListDto,
}

export { isEditableInstanceFilePath } from '../../../shared/contracts/instance-file'

export default {
  listFiles: (instanceId: string, path = '') => api.get('app/instance/files', {
    params: { instanceId, path },
  }) as Promise<{ data: InstanceFileListDto }>,
  listKeyFiles: (instanceId: string) => api.get('app/instance/files/key-files', {
    params: { instanceId },
  }) as Promise<{ data: InstanceKeyFileListDto }>,
  readFile: (instanceId: string, path: string) => api.get('app/instance/files/content', {
    params: { instanceId, path },
  }) as Promise<{ data: InstanceFileContentDto }>,
  writeFile: (payload: { instanceId: string, path: string, content: string }) => api.put('app/instance/files/content', payload) as Promise<{ data: InstanceFileWriteResult }>,
  deletePath: (payload: { instanceId: string, path: string }) => api.post('app/instance/files/delete', payload) as Promise<{ data: InstanceFileDeleteResult }>,
  renamePath: (payload: { instanceId: string, path: string, newName: string }) => api.post('app/instance/files/rename', payload) as Promise<{ data: InstanceFileRenameResult }>,
  /** 下载实例目录内的普通文件（敏感文件在后端就被拒绝） */
  downloadFile: (instanceId: string, path: string) => api.get('app/instance/files/download', {
    params: { instanceId, path },
    responseType: 'blob',
  }) as Promise<{ data: Blob }>,
  /** 上传单个文件到目标目录；onProgress 回传 0-99 的上传百分比 */
  uploadFile: (
    input: { instanceId: string, dirPath: string, file: File, overwrite?: boolean },
    onProgress?: (percent: number) => void,
  ) => {
    const params = new URLSearchParams({
      instanceId: input.instanceId,
      path: input.dirPath,
      fileName: input.file.name,
      overwrite: input.overwrite ? '1' : '0',
    })
    return api.post(`app/instance/files/upload?${params.toString()}`, input.file, {
      headers: { 'Content-Type': 'application/x-bsp-instance-file' },
      timeout: 0,
      onUploadProgress: (event: { loaded: number, total?: number }) => {
        if (onProgress && event.total) {
          onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)))
        }
      },
    }) as Promise<{ data: InstanceFileUploadResult }>
  },
}
