# Final integration checklist

## Dataset (Shruti)

- [ ] Final CSV received
- [ ] CSV columns verified
- [ ] Current units verified = µA
- [ ] Missing values checked
- [ ] Duplicate `Component_ID` checked
- [ ] Final CSV copied to `data/`

## Drift model (Kunal)

- [ ] Retrained model received
- [ ] `drift_model.pkl` placed in `models/`
- [ ] Model loads successfully
- [ ] `prediction_source` = `ML_MODEL`
- [ ] Prediction values are sensible
- [ ] MAE recorded in µA

## Frontend (Chaitanya)

- [ ] Frontend connected
- [ ] Healthy component test
- [ ] Latent defect test
- [ ] Obvious failure test
- [ ] Dynamic outlier test

## Release

- [ ] Final end-to-end demo
- [ ] Final Git commit
