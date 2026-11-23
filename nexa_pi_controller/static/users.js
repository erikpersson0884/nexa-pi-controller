const createAccountButton = document.getElementById('open-create-account');
const createAccountDialog = document.getElementById('create-account-dialog');

if (createAccountButton && createAccountDialog) {
  const openDialog = () => {
    if (!createAccountDialog.open) createAccountDialog.showModal();
  };
  createAccountButton.addEventListener('click', openDialog);

  if (new URLSearchParams(window.location.search).get('create') === '1') {
    openDialog();
  }
}
